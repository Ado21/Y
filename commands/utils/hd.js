import nodeFetch from 'node-fetch'
import crypto from 'crypto'
import FormDataPkg from 'form-data'
import fileTypePkg from 'file-type'
import { promises as fsp } from 'fs'
import fs from 'fs'
import os from 'os'
import path from 'path'

const { fileTypeFromBuffer } = fileTypePkg

const fetchFn = globalThis.fetch ? globalThis.fetch.bind(globalThis) : nodeFetch

function hasNativeMultipart() {
  return typeof globalThis.FormData !== 'undefined' && typeof globalThis.Blob !== 'undefined'
}

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

      const result = await imgupscalerEnhance(buffer, inputMime, x)

      if (!result?.ok || !result?.buffer) {
        const msg =
          result?.error?.code ||
          result?.error?.message ||
          result?.error?.step ||
          result?.create_upload?.code ||
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

function upscaleTypeFromX(x) {
  const v = Number(x)
  if (v === 2) return '8'
  if (v === 4) return '16'
  if (v === 8) return '32'
  if (v === 16) return '64'
  return '8'
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function safeJson(res) {
  const t = await res.text().catch(() => '')
  try {
    return JSON.parse(t)
  } catch {
    return { raw: t }
  }
}

async function fetchBytes(url, ua) {
  const r = await fetchFn(url, { method: 'GET', headers: { 'User-Agent': ua || 'Mozilla/5.0' } })
  if (!r.ok) return { ok: false, status: r.status, statusText: r.statusText, body: await r.text().catch(() => '') }
  const ab = await r.arrayBuffer()
  const ct = r.headers.get('content-type') || 'application/octet-stream'
  return { ok: true, contentType: ct, bytes: Buffer.from(ab) }
}

async function pollJob(API, headers, jobId, pollIntervalMs, timeoutMs) {
  const started = Date.now()
  let last = null

  while (Date.now() - started < timeoutMs) {
    const r = await fetchFn(`${API}/api/image-upscaler/v1/universal_upscale/get-job/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers
    })
    const j = await safeJson(r)
    last = j

    if (j?.code === 100000 && j?.result?.output_url?.length) return { done: true, data: j }
    if (j?.result?.input_url) return { done: true, data: j }
    if (j?.code && j.code !== 300006 && j.code !== 100000) return { done: true, data: j }

    await sleep(pollIntervalMs)
  }

  return { done: false, data: last }
}

function filenameFromMime(mime) {
  return /png/i.test(mime) ? 'input.png' : 'input.jpg'
}

async function createJobFromFileBufferNative(API, baseHeaders, buf, contentType, filename) {
  const fd = new globalThis.FormData()
  fd.set('original_image_file', new globalThis.Blob([buf], { type: contentType }), filename)

  const r = await fetchFn(`${API}/api/image-upscaler/v2/upscale/create-job`, {
    method: 'POST',
    headers: baseHeaders,
    body: fd
  })

  const j = await safeJson(r)
  return { ok: r.ok && j?.code === 100000 && j?.result?.job_id, status: r.status, body: j, job_id: j?.result?.job_id }
}

async function createJobFromTmpFileFallback(API, baseHeaders, tmpPath, contentType, filename) {
  const fd = new FormDataPkg()
  fd.append('original_image_file', fs.createReadStream(tmpPath), { filename, contentType })

  const headers = { ...baseHeaders, ...fd.getHeaders() }

  let length = null
  try {
    length = await new Promise((resolve, reject) => fd.getLength((err, len) => (err ? reject(err) : resolve(len))))
  } catch {}
  if (typeof length === 'number') headers['Content-Length'] = String(length)

  const r = await fetchFn(`${API}/api/image-upscaler/v2/upscale/create-job`, {
    method: 'POST',
    headers,
    body: fd
  })

  const j = await safeJson(r)
  return { ok: r.ok && j?.code === 100000 && j?.result?.job_id, status: r.status, body: j, job_id: j?.result?.job_id }
}

async function createUpscaleFromCdnUrlNative(API, baseHeaders, cdnUrl, upscaleType, imageWidth, imageHeight) {
  const fd = new globalThis.FormData()
  fd.set('original_image_url', String(cdnUrl))
  fd.set('upscale_type', String(upscaleType))
  fd.set('image_width', String(imageWidth))
  fd.set('image_height', String(imageHeight))

  const r = await fetchFn(`${API}/api/image-upscaler/v2/universal-upscale-for-url/create-job`, {
    method: 'POST',
    headers: baseHeaders,
    body: fd
  })

  const j = await safeJson(r)
  return { ok: r.ok && j?.code === 100000 && j?.result?.job_id, status: r.status, body: j, job_id: j?.result?.job_id }
}

async function createUpscaleFromCdnUrlFallback(API, baseHeaders, cdnUrl, upscaleType, imageWidth, imageHeight) {
  const fd = new FormDataPkg()
  fd.append('original_image_url', String(cdnUrl))
  fd.append('upscale_type', String(upscaleType))
  fd.append('image_width', String(imageWidth))
  fd.append('image_height', String(imageHeight))

  const headers = { ...baseHeaders, ...fd.getHeaders() }

  let length = null
  try {
    length = await new Promise((resolve, reject) => fd.getLength((err, len) => (err ? reject(err) : resolve(len))))
  } catch {}
  if (typeof length === 'number') headers['Content-Length'] = String(length)

  const r = await fetchFn(`${API}/api/image-upscaler/v2/universal-upscale-for-url/create-job`, {
    method: 'POST',
    headers,
    body: fd
  })

  const j = await safeJson(r)
  return { ok: r.ok && j?.code === 100000 && j?.result?.job_id, status: r.status, body: j, job_id: j?.result?.job_id }
}

async function imgupscalerEnhance(inputBuf, inputMime, upscaleX) {
  const API = 'https://api.imgupscaler.ai'
  const ORIGIN = 'https://imgupscaler.ai'

  const IMAGE_WIDTH = 2048
  const IMAGE_HEIGHT = 2048
  const POLL_INTERVAL_MS = 2000
  const TIMEOUT_MS = 120000

  const PRODUCT_SERIAL = crypto
    .createHash('md5')
    .update(`imgup-${Date.now()}-${Math.random()}`)
    .digest('hex')

  const TIMEZONE = 'America/Guatemala'
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'

  const baseHeaders = {
    Accept: '*/*',
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    'User-Agent': UA,
    'product-serial': PRODUCT_SERIAL,
    timezone: TIMEZONE
  }

  const out = {
    ok: false,
    provider: 'imgupscaler.ai',
    upscale_x: upscaleX,
    params: { image_width: IMAGE_WIDTH, image_height: IMAGE_HEIGHT },
    meta: { product_serial: PRODUCT_SERIAL, timezone: TIMEZONE }
  }

  const tmpDir = path.join(os.tmpdir(), 'imgupscaler')
  const tmpPath = path.join(tmpDir, `img_${Date.now()}_${Math.random().toString(16).slice(2)}_${filenameFromMime(inputMime)}`)

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    await fsp.writeFile(tmpPath, inputBuf)

    const uploadJob = hasNativeMultipart()
      ? await createJobFromFileBufferNative(API, baseHeaders, inputBuf, inputMime || 'image/jpeg', filenameFromMime(inputMime))
      : await createJobFromTmpFileFallback(API, baseHeaders, tmpPath, inputMime || 'image/jpeg', filenameFromMime(inputMime))

    out.create_upload = uploadJob.body
    if (!uploadJob.ok) {
      out.error = { step: 'upload-create-job', status: uploadJob.status, body: uploadJob.body, code: uploadJob.body?.code }
      return out
    }

    out.upload_job_id = uploadJob.job_id

    const polledUpload = await pollJob(API, baseHeaders, uploadJob.job_id, POLL_INTERVAL_MS, TIMEOUT_MS)
    out.upload_status = polledUpload.data

    const cdnInputUrl = polledUpload.data?.result?.input_url
    if (!polledUpload.done || !cdnInputUrl) {
      out.error = { step: 'poll-upload-job', message: 'no_cdn_input_url', body: polledUpload.data, code: polledUpload.data?.code }
      return out
    }

    out.cdn_input_url = cdnInputUrl

    const upscaleType = upscaleTypeFromX(upscaleX)

    const upscaleJob = hasNativeMultipart()
      ? await createUpscaleFromCdnUrlNative(API, baseHeaders, cdnInputUrl, upscaleType, IMAGE_WIDTH, IMAGE_HEIGHT)
      : await createUpscaleFromCdnUrlFallback(API, baseHeaders, cdnInputUrl, upscaleType, IMAGE_WIDTH, IMAGE_HEIGHT)

    out.create_upscale = upscaleJob.body
    if (!upscaleJob.ok) {
      out.error = { step: 'create-upscale-job', status: upscaleJob.status, body: upscaleJob.body, code: upscaleJob.body?.code }
      return out
    }

    out.upscale_job_id = upscaleJob.job_id

    const polledUpscale = await pollJob(API, baseHeaders, upscaleJob.job_id, POLL_INTERVAL_MS, TIMEOUT_MS)
    out.status = polledUpscale.data

    if (!polledUpscale.done) {
      out.error = { step: 'poll-upscale-job', message: 'timeout', timeoutMs: TIMEOUT_MS }
      return out
    }

    const result = polledUpscale.data?.result
    const outputUrl = result?.output_url?.[0]
    if (polledUpscale.data?.code !== 100000 || !outputUrl) {
      out.error = { step: 'poll-upscale-job', message: 'job_not_success', body: polledUpscale.data, code: polledUpscale.data?.code }
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