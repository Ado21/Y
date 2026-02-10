import fetch from 'node-fetch'
import crypto from 'crypto'
import FormData from 'form-data'
import fileTypePkg from 'file-type'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'

const { fileTypeFromBuffer } = fileTypePkg

export default {
  command: ['hd', 'enhance', 'remini'],
  category: 'utils',
  run: async (client, m, args, usedPrefix, command) => {
    try {
      const q = m.quoted || m
      const mime = q?.mimetype || q?.msg?.mimetype || ''

      if (!mime) return m.reply(`《✧》 Responde a una *imagen* con:\n${usedPrefix + command} 2|4|8|16`)
      if (!/^image\/(jpe?g|png)$/i.test(mime)) return m.reply(`《✧》 El formato *${mime || 'desconocido'}* no es compatible`)

      const x = Number(args?.[0])
      if (![2, 4, 8, 16].includes(x)) {
        return m.reply(
          `《✧》 Elige cuánto mejorar:\n${usedPrefix + command} 2\n${usedPrefix + command} 4\n${usedPrefix + command} 8\n${usedPrefix + command} 16`
        )
      }

      const buffer = await q.download?.()
      if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 10) return m.reply('《✧》 No se pudo descargar la imagen')

      const ft = await safeFileType(buffer)
      const inputMime = ft?.mime || mime || 'image/jpeg'
      if (!/^image\/(jpe?g|png)$/i.test(inputMime)) return m.reply(`《✧》 El formato *${inputMime}* no es compatible`)

      const result = await imgupscalerEnhanceViaCatbox(buffer, inputMime, x)

      if (!result?.ok || !result?.buffer) {
        const msg =
          result?.error?.message ||
          result?.error?.step ||
          result?.status?.code ||
          result?.create_upscale?.code ||
          'error'
        return m.reply(`《✧》 No se pudo *mejorar* la imagen (${msg})`)
      }

      await client.sendMessage(m.chat, { image: result.buffer, caption: null }, { quoted: m })
    } catch (e) {
      console.error(e)
      await m.reply(
        `> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e?.message || String(e)}*]`
      )
    }
  }
}

async function safeFileType(buf) {
  try {
    return await fileTypeFromBuffer(buf)
  } catch {
    return null
  }
}

function extFromMime(mime) {
  if (/png/i.test(mime)) return 'png'
  return 'jpg'
}

async function safeJson(res) {
  const t = await res.text().catch(() => '')
  try {
    return JSON.parse(t)
  } catch {
    return { raw: t }
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function fetchBytes(url, ua) {
  const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': ua || 'Mozilla/5.0' } })
  if (!r.ok) {
    return { ok: false, status: r.status, statusText: r.statusText, body: await r.text().catch(() => '') }
  }
  const ab = await r.arrayBuffer()
  return {
    ok: true,
    contentType: r.headers.get('content-type') || 'application/octet-stream',
    bytes: Buffer.from(ab)
  }
}

async function uploadToCatboxFromTmp(tmpPath) {
  const fd = new FormData()
  fd.append('reqtype', 'fileupload')
  fd.append('fileToUpload', await fsp.readFile(tmpPath), {
    filename: path.basename(tmpPath),
    contentType: 'application/octet-stream'
  })

  const r = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    headers: fd.getHeaders(),
    body: fd
  })

  const t = await r.text().catch(() => '')
  if (!r.ok) return { ok: false, status: r.status, statusText: r.statusText, body: t }

  const url = String(t || '').trim()
  if (!/^https?:\/\/.+/i.test(url)) return { ok: false, status: r.status, statusText: r.statusText, body: t }

  return { ok: true, url }
}

async function imgupscalerEnhanceViaCatbox(inputBuf, inputMime, upscaleX) {
  const API = 'https://api.imgupscaler.ai'
  const ORIGIN = 'https://imgupscaler.ai'
  const IMAGE_WIDTH = 2048
  const IMAGE_HEIGHT = 2048
  const POLL_INTERVAL_MS = 2000
  const TIMEOUT_MS = 120000
  const TIMEZONE = 'America/Guatemala'
  const PRODUCT_SERIAL = crypto
    .createHash('md5')
    .update(`imgup-${Date.now()}-${Math.random()}`)
    .digest('hex')

  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'

  function headers(extra = {}) {
    return {
      Accept: '*/*',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'User-Agent': UA,
      'product-serial': PRODUCT_SERIAL,
      timezone: TIMEZONE,
      ...extra
    }
  }

  function upscaleTypeFromX(x) {
    const v = Number(x)
    if (v === 2) return '8'
    if (v === 4) return '16'
    if (v === 8) return '32'
    if (v === 16) return '64'
    return '8'
  }

  async function pollJob(jobId) {
    const started = Date.now()
    let last = null

    while (Date.now() - started < TIMEOUT_MS) {
      const r = await fetch(`${API}/api/image-upscaler/v1/universal_upscale/get-job/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: headers()
      })
      const j = await safeJson(r)
      last = j

      if (j?.code === 100000 && j?.result?.output_url?.length) return { done: true, data: j }
      if (j?.code && j.code !== 300006 && j.code !== 100000) return { done: true, data: j }

      await sleep(POLL_INTERVAL_MS)
    }

    return { done: false, data: last }
  }

  async function createUpscaleFromUrl(imageUrl, upscaleType) {
    const fd = new FormData()
    fd.append('original_image_url', String(imageUrl))
    fd.append('upscale_type', String(upscaleType))
    fd.append('image_width', String(IMAGE_WIDTH))
    fd.append('image_height', String(IMAGE_HEIGHT))

    const r = await fetch(`${API}/api/image-upscaler/v2/universal-upscale-for-url/create-job`, {
      method: 'POST',
      headers: headers(fd.getHeaders()),
      body: fd
    })

    const j = await safeJson(r)
    return { ok: r.ok && j?.code === 100000 && j?.result?.job_id, status: r.status, body: j, job_id: j?.result?.job_id }
  }

  const out = {
    ok: false,
    provider: 'imgupscaler.ai',
    upscale_x: upscaleX,
    params: { image_width: IMAGE_WIDTH, image_height: IMAGE_HEIGHT },
    meta: { product_serial: PRODUCT_SERIAL, timezone: TIMEZONE }
  }

  const tmpDir = path.join(os.tmpdir(), 'imgupscaler')
  const tmpPath = path.join(tmpDir, `img_${Date.now()}_${Math.random().toString(16).slice(2)}.${extFromMime(inputMime)}`)

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    await fsp.writeFile(tmpPath, inputBuf)

    const up = await uploadToCatboxFromTmp(tmpPath)
    out.upload = up.ok ? { ok: true, url: up.url } : up
    if (!up.ok) {
      out.error = { step: 'upload-catbox', ...up }
      return out
    }

    out.input = { url: up.url }

    const upscaleType = upscaleTypeFromX(upscaleX)
    const job = await createUpscaleFromUrl(up.url, upscaleType)
    out.create_upscale = job.body
    if (!job.ok) {
      out.error = { step: 'create-upscale-job', status: job.status, body: job.body }
      return out
    }

    out.upscale_job_id = job.job_id

    const polled = await pollJob(job.job_id)
    out.status = polled.data

    if (!polled.done) {
      out.error = { step: 'poll-upscale-job', message: 'timeout', timeoutMs: TIMEOUT_MS }
      return out
    }

    const result = polled.data?.result
    const outputUrl = result?.output_url?.[0]
    if (polled.data?.code !== 100000 || !outputUrl) {
      out.error = { step: 'poll-upscale-job', message: 'job_not_success', body: polled.data }
      return out
    }

    const file = await fetchBytes(outputUrl, UA)
    if (!file.ok) {
      out.error = { step: 'download-output', ...file }
      return out
    }

    out.ok = true
    out.result = { input_url: result?.input_url, output_url: result?.output_url }
    out.buffer = file.bytes
    out.contentType = file.contentType
    return out
  } catch (e) {
    out.error = { step: 'exception', message: e?.message || String(e) }
    return out
  } finally {
    try {
      await fsp.unlink(tmpPath)
    } catch {}
  }
}