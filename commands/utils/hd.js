import fetch from 'node-fetch'
import crypto from 'crypto'
import FormData from 'form-data'
import { fileTypeFromBuffer } from 'file-type'

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
        return m.reply(`《✧》 Elige cuánto mejorar:\n${usedPrefix + command} 2\n${usedPrefix + command} 4\n${usedPrefix + command} 8\n${usedPrefix + command} 16`)
      }

      const buffer = await q.download?.()
      if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 10) {
        return m.reply('《✧》 No se pudo *descargar* la imagen')
      }

      const ft = await safeFileType(buffer)
      const inputMime = ft?.mime || mime || 'image/jpeg'

      if (!/^image\/(jpe?g|png)$/i.test(inputMime)) {
        return m.reply(`《✧》 El formato *${inputMime}* no es compatible`)
      }

      const result = await imgupscalerEnhanceFromBuffer(buffer, inputMime, x)
      if (!result?.ok) {
        const msg =
          result?.error?.message ||
          result?.error?.step ||
          result?.status?.code ||
          result?.create?.code ||
          result?.create_upload?.code ||
          result?.create_upscale?.code ||
          'error'
        return m.reply(`《✧》 No se pudo *mejorar* la imagen (${msg})`)
      }

      await client.sendMessage(
        m.chat,
        { image: result.buffer, caption: null },
        { quoted: m }
      )
    } catch (e) {
      console.error(e)
      await m.reply(
        `> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e?.message || String(e)}*]`
      )
    }
  }
}

function imgupHeaders(productSerial) {
  return {
    Accept: '*/*',
    Origin: 'https://imgupscaler.ai',
    Referer: 'https://imgupscaler.ai/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    'product-serial': String(productSerial),
    timezone: 'America/Guatemala'
  }
}

function imgupProductSerial() {
  return crypto
    .createHash('md5')
    .update(`imgup-${Date.now()}-${Math.random()}`)
    .digest('hex')
}

function upscaleTypeFromX(x) {
  const v = Number(x)
  if (v === 2) return '8'
  if (v === 4) return '16'
  if (v === 8) return '32'
  if (v === 16) return '64'
  return '16'
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

async function safeFileType(buf) {
  try {
    return await fileTypeFromBuffer(buf)
  } catch {
    return null
  }
}

async function pollJob(jobId, productSerial) {
  const started = Date.now()
  let last = null

  while (Date.now() - started < 120000) {
    const r = await fetch(
      `https://api.imgupscaler.ai/api/image-upscaler/v1/universal_upscale/get-job/${encodeURIComponent(
        jobId
      )}`,
      { method: 'GET', headers: imgupHeaders(productSerial) }
    )
    const j = await safeJson(r)
    last = j

    if (j?.code === 100000 && j?.result?.output_url?.length) return { done: true, data: j }
    if (j?.result?.input_url) return { done: true, data: j }
    if (j?.code && j.code !== 300006 && j.code !== 100000) return { done: true, data: j }

    await sleep(2000)
  }

  return { done: false, data: last }
}

function filenameFromMime(mime) {
  if (/png/i.test(mime)) return 'input.png'
  return 'input.jpg'
}

async function createJobFromFileBuffer(buf, contentType, filename, productSerial) {
  const fd = new FormData()
  fd.append('original_image_file', buf, { filename, contentType })

  const r = await fetch(
    `https://api.imgupscaler.ai/api/image-upscaler/v2/upscale/create-job`,
    {
      method: 'POST',
      headers: { ...imgupHeaders(productSerial), ...fd.getHeaders() },
      body: fd
    }
  )

  const j = await safeJson(r)
  return {
    ok: r.ok && j?.code === 100000 && j?.result?.job_id,
    status: r.status,
    body: j,
    job_id: j?.result?.job_id
  }
}

async function createUpscaleFromCdnUrl(cdnUrl, upscaleType, imageWidth, imageHeight, productSerial) {
  const fd = new FormData()
  fd.append('original_image_url', String(cdnUrl))
  fd.append('upscale_type', String(upscaleType))
  fd.append('image_width', String(imageWidth))
  fd.append('image_height', String(imageHeight))

  const r = await fetch(
    `https://api.imgupscaler.ai/api/image-upscaler/v2/universal-upscale-for-url/create-job`,
    {
      method: 'POST',
      headers: { ...imgupHeaders(productSerial), ...fd.getHeaders() },
      body: fd
    }
  )

  const j = await safeJson(r)
  return {
    ok: r.ok && j?.code === 100000 && j?.result?.job_id,
    status: r.status,
    body: j,
    job_id: j?.result?.job_id
  }
}

async function fetchBytes(url) {
  const r = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  })
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      statusText: r.statusText,
      body: await r.text().catch(() => '')
    }
  }
  const ab = await r.arrayBuffer()
  return {
    ok: true,
    contentType: r.headers.get('content-type') || 'application/octet-stream',
    bytes: Buffer.from(ab)
  }
}

async function imgupscalerEnhanceFromBuffer(inputBuf, inputMime, upscaleX) {
  const productSerial = imgupProductSerial()
  const out = {
    ok: false,
    provider: 'imgupscaler.ai',
    upscale_x: upscaleX,
    meta: { product_serial: productSerial, timezone: 'America/Guatemala' }
  }

  try {
    const fileJob = await createJobFromFileBuffer(
      inputBuf,
      inputMime || 'image/jpeg',
      filenameFromMime(inputMime),
      productSerial
    )
    out.create_upload = fileJob.body
    if (!fileJob.ok) {
      out.error = { step: 'upload-create-job', status: fileJob.status, body: fileJob.body }
      return out
    }

    out.upload_job_id = fileJob.job_id
    const polledUpload = await pollJob(fileJob.job_id, productSerial)
    out.upload_status = polledUpload.data
    const cdnInputUrl = polledUpload.data?.result?.input_url
    if (!polledUpload.done || !cdnInputUrl) {
      out.error = { step: 'poll-upload-job', message: 'no_cdn_input_url', body: polledUpload.data }
      return out
    }

    out.cdn_input_url = cdnInputUrl
    const upscaleType = upscaleTypeFromX(upscaleX)

    const upscaleJob = await createUpscaleFromCdnUrl(
      cdnInputUrl,
      upscaleType,
      2048,
      2048,
      productSerial
    )
    out.create_upscale = upscaleJob.body
    if (!upscaleJob.ok) {
      out.error = { step: 'create-upscale-job', status: upscaleJob.status, body: upscaleJob.body }
      return out
    }

    out.upscale_job_id = upscaleJob.job_id
    const polledUpscale = await pollJob(upscaleJob.job_id, productSerial)
    out.status = polledUpscale.data

    if (!polledUpscale.done) {
      out.error = { step: 'poll-upscale-job', message: 'timeout', timeoutMs: 120000 }
      return out
    }

    const result = polledUpscale.data?.result
    const outputUrl = result?.output_url?.[0]
    if (polledUpscale.data?.code !== 100000 || !outputUrl) {
      out.error = { step: 'poll-upscale-job', message: 'job_not_success', body: polledUpscale.data }
      return out
    }

    const file = await fetchBytes(outputUrl)
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
  }
}