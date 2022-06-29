import * as cheerio     from 'cheerio'
import fetch            from 'node-fetch'
import dedent           from 'dedent'
import { segment }      from 'oicq'
import Scm              from 'schemastery'
import HttpsProxyAgent  from 'https-proxy-agent'
import {
    randomItem, streamToBuffer
}                   from '../util/toolkit.js'

const pixiv = 'https://www.pixiv.net'

const modes = [ 'daily', 'weekly', 'monthly', 'rookie', 'original', 'male', 'female' ]

export default ({ command: { CmdError } }, cfg) => {
    const agent = cfg.proxy && new HttpsProxyAgent(cfg.proxy)
    const subs = {
        rank: {
            help: dedent`
                Get artwork from Pixiv ranking.
                Available [mode]: ${modes.join(', ')}.
                Use [rank] to get the artwork at a specific ranking, or get a random one.
                Use YYYYMMDD to specify [date].
            `,
            args: [
                { ty: '$msg' },
                { ty: 'str', name: 'mode', opt: true },
                { ty: 'bool', name: 'r18', opt: true },
                { ty: 'num', name: 'date', opt: true },
                { ty: 'num', name: 'rank', int: true, opt: true },
                { ty: 'bool', name: 'verbose', opt: true }
            ],
            async fn (msg, mode = 'daily', r18, date, rk, verbose) {
                if (! modes.includes(mode))
                    return new CmdError('Illegal mode.')
                if (r18) {
                    return new CmdError('R18 is not available now.')
                    if (! [ 'daily', 'weekly', 'male', 'female' ].includes(mode))
                        return new CmdError('Illegal R18 mode.')
                    mode += '_r18'
                }
                const param = { mode }
                if (date) param.date = date
                const rank = await (
                    await fetch(`${pixiv}/ranking.php?` + new URLSearchParams(param), { agent })
                ).text()

                const $rank = cheerio.load(rank)
                const artUrls = [ ... $rank('.ranking-items > section > div > a.work') ]
                    .map(el => el.attribs.href)

                let artUrl, artId
                if (rk) {
                    artUrl = artUrls[rk - 1]
                    artId = artUrl.split('/').at(-1)
                }
                else if (msg.message_type === 'group') {
                    const col = await bot.mongo.db.collection(`pixiv_group_history`)
                    const { history = {} } = await col.findOne({ _id: msg.group_id }) ?? {}
                    do {
                        if (! (artUrl = randomItem(artUrls))) {
                            return 'Not found.'
                        }
                        artId = artUrl.split('/').at(-1)
                    }
                    while (history[artId])
                    await col.updateOne(
                        { _id: msg.group_id },
                        { $set: { [`history.${artId}`]: true } },
                        { upsert: true }
                    )
                }

                return [
                    verbose
                        ? `Getting ${rk ? rk + '#' : 'a random'} artwork from ${mode} ranking. id: ${artId}`
                        : artId,
                    await subs.get.fn(artId)
                ]
            }
        },

        get: {
            help: 'Get a Pixiv artwork by <id>.',
            args: [
                { ty: 'str', name: 'id' }
            ],
            fn: async (id) => {
                const artUrl = `${pixiv}/artworks/${id}`
                const art = await (await fetch(artUrl, { agent })).text()

                bot.art = art

                const $art = cheerio.load(art)

                const [ $data ] = $art('#meta-preload-data')
                const data = JSON.parse($data.attribs.content.replace(/\r\n/g, ''))
                const imgData = data.illust[id]

                const img = await fetch(imgData.urls.regular, {
                    headers: { Referer: artUrl },
                    agent
                })

                return segment.image(await streamToBuffer(img.body))
            }
        }
    }

    return {
        help: 'Pixiv!',
        subs
    }
}

export const config = Scm.object({
    proxy: Scm.string()
})