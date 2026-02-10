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

          if (!buffer || buffer.length === 0) continue

          let webpBuffer = buffer

          // Función para detectar si el buffer ya es un WebP (Magic Bytes)
          const isWebP = (buf) => {
             // WebP empieza con RIFF....WEBP
             return buf.length > 12 &&
                   buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
                   buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
          }

          // SOLO convertimos si NO es WebP (ej. si es PNG o JPG)
          // Si ya es WebP, lo usamos directo para evitar el error de FFmpeg con animaciones
          if (!isWebP(buffer)) {
            let ext = path.extname(imgUrl).split('?')[0]
            if (!ext || ext.length > 5) ext = '.png'

            const inFile = tmp(`in-${Date.now()}-${i}${ext}`)
            const outFile = tmp(`out-${Date.now()}-${i}.webp`)

            fs.writeFileSync(inFile, buffer)

            try {
              await runFfmpeg([
                '-y',
                '-i', inFile,
                '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
                '-c:v', 'libwebp',
                '-lossless', '1',
                outFile
              ])

              if (fs.existsSync(outFile)) {
                webpBuffer = fs.readFileSync(outFile)
              } else {
                throw new Error('Output file not created')
              }
            } catch (err) {
              console.error('FFmpeg Error:', err.message)
              // Si falla la conversión, intentamos seguir con el original si fuera posible
              throw err
            } finally {
              if (fs.existsSync(inFile)) fs.unlinkSync(inFile)
              if (fs.existsSync(outFile)) fs.unlinkSync(outFile)
            }
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
    let stderr = ''
    p.stderr.on('data', (chunk) => { stderr += chunk })
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr || 'ffmpeg error'))
    })
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
    let href = $(el).attr('href')
    if (title && href) {
      if (!href.startsWith('http')) {
        href = 'https://getstickerpack.com' + href
      }
      packs.push({ title, url: href })
    }
  })

  return packs
}

async function getStickers(url) {
  const res = await axios.get(url)
  const $ = cheerio.load(res.data)

  const links = []

  $('img.sticker-image').each((_, el) => {
    let src = $(el).attr('data-src-large') || $(el).attr('src')
    if (src) {
      if (!src.startsWith('http')) {
        src = 'https://getstickerpack.com' + src
      }
      links.push(src)
    }
  })

  return links
}