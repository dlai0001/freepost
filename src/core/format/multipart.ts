/**
 * Assemble a multipart/form-data request body. Pure and transport-agnostic:
 * callers resolve each part's bytes (reading files, applying ${VAR}
 * substitution) and pass concrete content here. The engine sends the returned
 * Buffer as-is; freepost.form (frontmatter) is the source of truth for the
 * fields, since the generated curl --form line can only approximate them.
 */

/** One resolved part of a multipart body. */
export interface MultipartPart {
  name: string
  /** Sent as the Content-Disposition filename; marks the part as a file upload. */
  filename?: string
  /** Explicit Content-Type for the part (e.g. application/json). */
  contentType?: string
  /** The part's bytes; strings are encoded as UTF-8. */
  content: Buffer | string
}

const CRLF = '\r\n'

/** The Content-Type header value for a body built with this boundary. */
export function multipartContentType(boundary: string): string {
  return `multipart/form-data; boundary=${boundary}`
}

/** Escape a value for use inside a Content-Disposition quoted-string. */
function quoteDisposition(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')
}

/** Build the raw multipart body for the given parts and boundary. */
export function buildMultipartBody(parts: MultipartPart[], boundary: string): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    let header = `--${boundary}${CRLF}Content-Disposition: form-data; name="${quoteDisposition(part.name)}"`
    if (part.filename !== undefined) {
      header += `; filename="${quoteDisposition(part.filename)}"`
    }
    header += CRLF
    if (part.contentType !== undefined) header += `Content-Type: ${part.contentType}${CRLF}`
    header += CRLF
    chunks.push(Buffer.from(header, 'utf8'))
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content, 'utf8'))
    chunks.push(Buffer.from(CRLF, 'utf8'))
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'))
  return Buffer.concat(chunks)
}
