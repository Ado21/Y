import axios from 'axios'
import cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import exif from '../../lib/exif.js'

const { writeExif } = exif

export default {
  command: ['stickers', 'searchsticker'],
  category: 'utils',
  run: async (client, m, args) => {
    const raw = (args || []).join(' ').trim()
    if (!raw) return m.reply('《✧》 Por favor, ingresa el nombre de los *stickers* a buscar.')

    ensureTmp()

    try {
      const { query, packname, author } = parseQueryAndMeta(raw, m)

      const packs = await searchSticker(query)
      if (!packs.length) return m.reply('《✧》 No se encontraron resultados.')

      const pack = packs[0]
      const stickerUrls = await getStickers(pack.url)
      if (!stickerUrls.length) return m.reply('《✧》 El pack no contiene stickers.')

      await m.reply(`《✧》 Enviando *stickers* del pack: _*${pack.title}*_`)

      const limit = 5

      for (let i = 0; i < Math.min(stickerUrls.length, limit); i++) {
        try {
          const imgUrl = stickerUrls[i]
          const buffer = await downloadBuffer(imgUrl)

          let webpBuffer = buffer

          if (!imgUrl.toLowerCase().endsWith('.webp')) {
            const inFile = tmp(`in-${Date.now()}-${i}.img`)
            const outFile = tmp(`out-${Date.now()}-${i}.webp`)

            fs.writeFileSync(inFile, buffer)

            await runFfmpeg([
              '-y',
              '-i', inFile,
              '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
              '-c:v', 'libwebp',
              '-lossless', '1',
              outFile
            ])

            webpBuffer = fs.readFileSync(outFile)

            fs.unlinkSync(inFile)
            fs.unlinkSync(outFile)
          }

          const stickerPath = await writeExif(
            { mimetype: 'webp', data: webpBuffer },
            { packname, author, categories: [''] }
          )

          await client.sendMessage(m.chat, { sticker: { url: stickerPath } }, { quoted: m })
          fs.unlinkSync(stickerPath)

        } catch (e) {
          console.error(e)
        }
      }

    } catch (e) {
      m.reply(`Error: ${e.message}`)
    }
  }
}

const tmp = (name) => path.join('./tmp', name)
const ensureTmp = () => {
  if (!fs.existsSync('./tmp')) fs.mkdirSync('./tmp', { recursive: true })
}

const runFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args)
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg error')))
  })

const downloadBuffer = async (url) => {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { Referer: 'https://getstickerpack.com' }
  })
  return Buffer.from(res.data)
}

const parseQueryAndMeta = (raw, m) => {
  const parts = raw.split('|').map(x => x.trim()).filter(Boolean)

  const user = global.db?.data?.users?.[m.sender] || {}

  return {
    query: parts[0],
    packname: parts[1] || user.metadatos || "ʏᴜᴋɪ 🧠 Wᴀʙᴏᴛ'ꜱ",
    author: parts[2] || user.metadatos2 || `${m.pushName}`
  }
}

async function searchSticker(query) {
  const res = await axios.get(`https://getstickerpack.com/stickers?query=${encodeURIComponent(query)}`)
  const $ = cheerio.load(res.data)

  const packs = []

  $('.sticker-pack-cols a').each((_, el) => {
    const title = $(el).find('.title').text().trim()
    const href = $(el).attr('href')
    if (title && href) packs.push({ title, url: 'https://getstickerpack.com' + href })
  })

  return packs
}

async function getStickers(url) {
  const res = await axios.get(url)
  const $ = cheerio.load(res.data)

  const links = []

  $('img.sticker-image').each((_, el) => {
    const src = $(el).attr('data-src-large') || $(el).attr('src')
    if (src) links.push(src)
  })

  return links
}