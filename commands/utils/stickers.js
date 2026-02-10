import axios from 'axios'
import cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export default {
command: ['stickers', 'searchsticker'],
category: 'sticker',
run: async (client, m, args, usedPrefix, command) => {
const text = args.join(' ').trim()
if (!text) {
return m.reply('《✧》 Por favor, ingresa el nombre del sticker a buscar.')
}

try {
const packs = await searchSticker(text)
if (!packs.length) {
return m.reply('《✧》 No se encontraron resultados.')
}

const pack = packs[0]
const stickerUrls = await getStickers(pack.url)

if (!stickerUrls.length) {
return m.reply('《✧》 El pack no contiene stickers.')
}

await m.reply(`《✧》 Enviando stickers del pack: ${pack.title}`)

const limit = 5
for (let i = 0; i < Math.min(stickerUrls.length, limit); i++) {
try {
const imgUrl = stickerUrls[i]
const res = await axios.get(imgUrl, { responseType: 'arraybuffer' })
const buffer = Buffer.from(res.data)

const tmpDir = os.tmpdir()
const inputPath = path.join(tmpDir, `input_${Date.now()}.png`)
const outputPath = path.join(tmpDir, `output_${Date.now()}.webp`)

fs.writeFileSync(inputPath, buffer)

await execAsync(`ffmpeg -i ${inputPath} -vf "scale='min(320,iw)':-2" -f webp -vcodec libwebp -lossless 1 ${outputPath}`)

const stickerBuffer = fs.readFileSync(outputPath)

await client.sendMessage(m.chat, { sticker: stickerBuffer }, { quoted: m })

fs.unlinkSync(inputPath)
fs.unlinkSync(outputPath)
} catch (e) {
console.error(e)
}
}
} catch (e) {
return m.reply(`> An unexpected error occurred.\n> [Error: *${e.message}*]`)
}
}
}

const baseUrl = 'https://getstickerpack.com'

async function searchSticker(query) {
const res = await axios.get(`${baseUrl}/stickers?query=${encodeURIComponent(query)}`)
const $ = cheerio.load(res.data)
const packs = []

 $('.sticker-pack-cols a').each((_, el) => {
const title = $(el).find('.title').text().trim()
const href = $(el).attr('href')?.trim()
if (title && href) {
const fullUrl = href.startsWith('http') ? href : baseUrl + href
packs.push({ title, url: fullUrl })
}
})

return packs
}

async function getStickers(packUrl) {
const res = await axios.get(packUrl)
const $ = cheerio.load(res.data)
const links = []

 $('img.sticker-image').each((_, el) => {
const src = $(el).attr('data-src-large')
if (src) links.push(src)
})

return links
}