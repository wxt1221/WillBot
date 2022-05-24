import { fileURLToPath }	from 'node:url'
import fs					from 'node:fs/promises'
import path					from 'node:path'
import chalk				from 'chalk'
import minimist				from 'minimist'
import shell				from '../util/shell.js'

const suffix = '.will.js'

export const helphelp = {
	__inited: true,
	alias: [ 'help' ],
	args: [],
	fn: () => '?: alias: help\nusage: ?\nhelp: get help',
	subs: {}
}

helphelp.subs['?'] = helphelp.subs.help = helphelp

export const initCmd = (cmd, cmdName) => {
	if (cmd.__inited) return
	cmd.__inited = true

	const parseStrArg = ([ name, ty, ...rest ]) => ({
		ty, name,
		...Object.fromEntries(rest.map(k => [ k, true ]))
	})
	cmd.args = cmd.args?.map(arg => typeof arg === 'string'
		? parseStrArg(arg.split(':'))
		: arg)

	const subs = cmd.subs ??= {}
	for (const subName in subs) {
		initCmd(subs[subName], subName)
	}
	subs['?'] ??= {
		alias: [ 'help' ],
		args: [],
		fn: () => `${cmdName}: `
			+ `[perm] ${cmd.perm ??= 0}`
			+ (cmd.alias?.length ? `, [alias] ${cmd.alias.join(', ')}` : '')
			+ `\n[subs] ${Object.keys(subs).join(', ') || 'none'}\n`
			+ (cmd.args
				? `[usage] ${cmdName} ${ cmd.args
					.map(({ ty, name, opt, named, perm }) => {
						if (ty[0] === '$')	return
						perm = perm ? `[perm] ${perm} ` : ''
						if (named)			return `[--${perm}${name}: ${ty}]`
						if (opt)			return `[${perm}${name}: ${ty}]`
						if (named)			return `<${perm}${name}: ${ty}>`
					})
					.filter(s => s)
					.join(' ')
				}\n`
				: '[no usage]\n'
			)
			+ `[help] ${cmd.help ?? 'no information'}`,
		subs: {
			'?': helphelp,
			help: helphelp
		}
	}
	for (const subName in subs) {
		subs[subName].alias?.forEach(alias => {
			subs[alias] = subs[subName]
		})
	}
}

const _loadCmd = async (file) => {
	const { default: fn, name } = await import(
		path.resolve(srcPath, 'commands', file + `?date=${Date.now()}`)
	)
	const willName = name ?? file.slice(0, - suffix.length)
	try {
		bot.logger.info(`Loading will ${chalk.cyan(willName)}...`)
		initCmd(
			bot.cmds.subs[willName] = await fn(bot),
			willName
		)
	}
	catch (err) {
		bot.logger.err(`Failed to load will ${chalk.cyan(willName)}`)(err)
	}
}

export const srcPath = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export const loadCmd = async (glob) => {
	for (const file of glob === '*'
		? (await fs.readdir(path.resolve(srcPath, 'commands')))
			.filter(file => file.endsWith(suffix))
		: Array.isArray(glob) ? glob : [ glob ]
	) await _loadCmd(file)
}

export const findCmd = (cmdName) => {
	let now = bot.cmds
	if (! cmdName) return now
	const names = cmdName.split('.')
	for (const name of names) {
		if (! Object.prototype.hasOwnProperty.call(now.subs, name)) return null
		now = now.subs[name]
	}
	return now
}

export const findCmdWith = async (cmdName, uid) => {
	let cmd = findCmd(cmdName)
	if (! cmd) {
		const withCmds = (await bot.mongo.db
			.collection('my_with')
			.findOne({ _id: uid }))
			?.commands
		if (withCmds) for (const c of withCmds) {
			if (cmd = findCmd(c + '.' + cmdName)) break
		}
	}
	return cmd
}

export class CmdError extends Error {
	constructor(msg, doLog) {
		super(msg)
		if (doLog) bot.logger.err('Handled internal error')(msg)
	}
}

export class PermError extends Error {
	constructor(level, why) {
		super(`permission denied${ why ? ' for ' + why : '' } (Require ${level})`)
	}
}

export const runCmd = async (msg) => {
	let raw = msg.raw_message.trimStart() || '?'
	const uid = msg.sender.user_id
	bot.logger.info('Running by %d: %s', uid, raw)

	msg.reply.err = err => {
		msg.reply((bot.cfg.commands['error-prefix'] ?? '') + err)
	}

	const env = bot.userEnv[uid] ??= (await bot.mongo.db
		.collection('my_env')
		.findOne({ _id: uid }))
		?.env ?? {}

	const perm = uid === 0
		? Infinity
		: (await bot.mongo.db
			.collection('perm')
			.findOne({ _id: uid })
		)?.level ?? 0

	const [ tokens, flags ] = shell(raw, env)
	const [ cmdName, ...args ] = tokens
	const { _: miniArgs, ...named } = minimist(args)

	if (flags.dq) return msg.reply.err('unmatched "')
	if (flags.sq) return msg.reply.err('unmatched \'')

	const [ head, ...tail ] = cmdName.split('.')
	const alias = await bot.mongo.db.collection('my_alias').findOne({ uid, alias: head })
	const cookedCmdName = [ alias ? alias.command : head, ...tail ].join('.')

	try {
		const cmd = await findCmdWith(cookedCmdName, uid)
		if (! cmd) throw 'not found'
		if (! cmd.fn) throw 'not executable'

		if (perm < cmd.perm) throw new PermError(cmd.perm)

		const cookedArgs = cmd.args.map((rule) => {
			const argErr = `arg (${rule.name}: ${rule.ty}): `
			if (perm < rule.perm ?? 0) throw new PermError(rule.perm, argErr.slice(0, -1))
			switch (rule.ty) {
			case '$msg':
				return msg
			case '$uid':
				return uid
			case '$flags':
				return flags
			case '$tokens':
				return tokens
			case '$self':
				return cmd
			case '$checkPerm':
				return (level, why) => {
					if (perm < level) throw new PermError(level, why)
				}
			case 'text':
				return miniArgs.splice(0).join(' ')
			case 'str':
			case 'bool':
			case 'num': {
				let arg
				if (rule.name in named) {
					arg = named[rule.name]
					if (arg && rule.named === false) throw `${rule.name}: forbidden named arg`
					delete named[rule.name]
				}
				else {
					if (rule.named) return
					arg = miniArgs.shift()
					if (arg === undefined) {
						if (! rule.opt) throw 'too few args'
						return
					}
				}
				if (rule.ty === 'num') {
					arg = Number(arg)
					if (isNaN(arg)) throw argErr + 'not a number'
					if (rule.int && (arg | 0) !== arg) throw argErr + 'not an integer'
				}
				if (rule.ty === 'bool') {
					if (`${arg}` === 'true') arg = true
					else if (`${arg}` === 'false') arg = false
					else throw argErr + 'not a boolean (true or false)'
				}
				if (rule.ty === 'str') {
					arg = String(arg)
				}
				return arg
			}
			default:
				throw `${rule.ty}: unknown arg type (internal error)`
			}
		})

		const rest = Object.keys(named)
		if (rest.length) throw rest.join(', ') + ': unknown named arg'

		if (miniArgs.length) throw 'too many args'

		try {
			const reply = await cmd.fn(...cookedArgs)
			if (reply instanceof CmdError) msg.reply.err(reply.message)
			else if (reply) msg.reply(reply)
			else throw 'Empty reply'
		}
		catch (err) {
			if (err instanceof PermError) throw err
			bot.logger.err(`Caught internal error in ${cookedCmdName}`)(err)
			throw (err?.message ?? err) + ' (internal error)'
		}
	}
	catch (err) {
		if (err instanceof PermError) return msg.reply.err(err.message)
		msg.reply.err(`${cookedCmdName}: ${err}`)
	}
}
