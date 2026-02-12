import fetch from 'node-fetch'
import axios from 'axios'

export default {
  command: ['instagram', 'ig'],
  category: 'downloader',
  run: async (client, m, args, usedPrefix, command) => {
    if (!args[0]) {
      return m.reply('《✧》 Por favor, ingrese un enlace de Instagram.')
    }

    if (!args[0].match(/instagram\.com\/(p|reel|share|tv|stories)\//i)) {
      return m.reply('《✧》 El enlace no parece válido. Asegúrate de que sea de Instagram.')
    }

    try {
      const data = await getInstagramMedia(args[0])
      if (!data) return m.reply('《✧》 No se pudo obtener el contenido.')

      const caption =
        `ㅤ۟∩　ׅ　★ ໌　ׅ　🅘𝖦 🅓ownload　ׄᰙ\n\n` +
        `${data.title ? `𖣣ֶㅤ֯⌗ ❀  ⬭ Usuario › ${data.title}\n` : ''}` +
        `${data.caption ? `𖣣ֶㅤ֯⌗ ❀  ⬭ Descripción › ${data.caption}\n` : ''}` +
        `${data.like ? `𖣣ֶㅤ֯⌗ ❀  ⬭ Likes › ${data.like}\n` : ''}` +
        `${data.comment ? `𖣣ֶㅤ֯⌗ ❀  ⬭ Comentarios › ${data.comment}\n` : ''}` +
        `${data.views ? `𖣣ֶㅤ֯⌗ ❀  ⬭ Vistas › ${data.views}\n` : ''}` +
        `${data.duration ? `𖣣ֶㅤ֯⌗ ❀  ⬭ Duración › ${data.duration}\n` : ''}` +
        `${data.resolution ? `𖣣ֶㅤ֯⌗ ❀  ⬭ Resolución › ${data.resolution}\n` : ''}` +
        `${data.format ? `𖣣ֶㅤ֯⌗ ❀  ⬭ Formato › ${data.format}\n` : ''}` +
        `𖣣ֶㅤ֯⌗ ❀  ⬭ *Enlace* › ${args[0]}`

      if (data.type === 'video') {
        await client.sendMessage(
          m.chat,
          { video: { url: data.url }, caption, mimetype: 'video/mp4', fileName: 'ig.mp4' },
          { quoted: m }
        )
      } else if (data.type === 'image') {
        await client.sendMessage(m.chat, { image: { url: data.url }, caption }, { quoted: m })
      } else {
        throw new Error('Contenido no soportado.')
      }
    } catch (e) {
      await m.reply(
        `> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e.message}*]`
      )
    }
  }
}

async function getInstagramMedia(url) {
  const scraped = await downloadInstagram(url)
  if (!scraped?.success || !scraped?.data?.url) return null

  return {
    type: scraped.data.type === 'video' ? 'video' : 'image',
    title: scraped.data.title || null,
    caption: scraped.data.caption || null,
    like: scraped.data.like || null,
    comment: scraped.data.comment || null,
    views: scraped.data.views || null,
    duration: scraped.data.duration || null,
    resolution: scraped.data.resolution || null,
    format: scraped.data.type === 'video' ? 'mp4' : 'jpg',
    url: scraped.data.url
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const headers = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Cache-Control': 'max-age=0',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent': UA
}

async function downloadInstagram(url) {
  try {
    const shortcode = extractShortcode(url)
    if (!shortcode) return { success: false, error: 'No se pudo extraer el shortcode del post.' }

    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`
    const html = await axios.get(embedUrl, { headers, timeout: 15000 }).then(r => r.data)

    const data = parseEmbed(html)
    if (!data) return { success: false, error: 'No se pudo obtener datos del embed.' }

    const media = data?.gql_data || data
    const mainMedia = media?.shortcode_media || media?.xdt_shortcode_media
    if (!mainMedia) return { success: false, error: 'Contenido no disponible.' }

    const title =
      mainMedia?.edge_media_to_caption?.edges?.[0]?.node?.text ||
      mainMedia?.caption?.text ||
      'Instagram Post'

    if (mainMedia.video_url) {
      return {
        success: true,
        data: { type: 'video', title, thumbnail: mainMedia.display_url, url: mainMedia.video_url }
      }
    }

    const sidecar = mainMedia?.edge_sidecar_to_children?.edges || []
    if (sidecar.length) {
      const nodes = sidecar.map(e => e?.node).filter(Boolean)
      const firstVideo = nodes.find(n => n?.video_url)
      if (firstVideo?.video_url) {
        return {
          success: true,
          data: {
            type: 'video',
            title,
            thumbnail: firstVideo.display_url || mainMedia.display_url,
            url: firstVideo.video_url
          }
        }
      }

      const firstImage = nodes.find(n => n?.display_url)
      if (firstImage?.display_url) {
        return {
          success: true,
          data: { type: 'image', title, thumbnail: firstImage.display_url, url: firstImage.display_url }
        }
      }
    }

    if (mainMedia.display_url) {
      return {
        success: true,
        data: { type: 'image', title, thumbnail: mainMedia.display_url, url: mainMedia.display_url }
      }
    }

    return { success: false, error: 'No se encontró contenido descargable.' }
  } catch (e) {
    return { success: false, error: e.message || 'Error al procesar el post.' }
  }
}

function extractShortcode(url) {
  let match = url.match(/\/p\/([A-Za-z0-9_-]+)\//i)
  if (match) return match[1]
  match = url.match(/\/reel\/([A-Za-z0-9_-]+)\//i)
  if (match) return match[1]
  match = url.match(/\/tv\/([A-Za-z0-9_-]+)\//i)
  if (match) return match[1]
  return null
}

function parseEmbed(html) {
  const m =
    html.match(/"contextJSON"\s*:\s*"([^"]+)"/) ||
    html.match(/"gql_data"\s*:\s*({.*?})\s*,\s*"show_caption"/s) ||
    html.match(/"init"\s*,\s*\[\s*\]\s*,\s*\[(.*?)\]\s*,/s)

  if (!m) return null

  try {
    if (m[0].includes('"contextJSON"')) {
      const raw = m[1]
      const unescaped = raw
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\u003c/g, '<')
        .replace(/\\u003e/g, '>')
        .replace(/\\u0026/g, '&')
        .replace(/\\\\/g, '\\')
      return JSON.parse(unescaped)
    }

    const json = (m[1] || '').trim()
    if (!json) return null

    const parsed = JSON.parse(json)
    if (parsed?.contextJSON) return JSON.parse(parsed.contextJSON)
    return parsed
  } catch {
    return null
  }
}