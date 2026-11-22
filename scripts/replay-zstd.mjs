import { zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xfd2fb528
const SKIPPABLE_FIRST = 0x184d2a50
const MAX_FRAME_OUTPUT = 64 * 1024 * 1024
const DICTIONARY_LENGTH = [0, 1, 2, 4]

// Frame boundaries follow RFC 8878. A block may itself contain the magic bytes.
export function* decodeFrames(buffer) {
  let cursor = 0
  function requireBytes(count) {
    if (cursor + count > buffer.length) throw new Error('truncatedFrame')
  }
  while (cursor < buffer.length) {
    const start = cursor
    requireBytes(4)
    const magic = buffer.readUInt32LE(cursor)
    cursor += 4
    if (magic >= SKIPPABLE_FIRST && magic < SKIPPABLE_FIRST + 16) {
      requireBytes(4)
      const size = buffer.readUInt32LE(cursor)
      cursor += 4
      requireBytes(size)
      cursor += size
      continue
    }
    if (magic !== MAGIC) throw new Error('invalidFrameMagic')
    requireBytes(1)
    const descriptor = buffer[cursor++]
    if (descriptor & 8) throw new Error('invalidFrameHeader')
    const singleSegment = Boolean(descriptor & 32)
    const sizeFlag = descriptor >> 6
    const sizeLength = sizeFlag ? 2 ** sizeFlag : Number(singleSegment)
    const dictionaryLength = DICTIONARY_LENGTH[descriptor & 3]
    const windowLength = Number(!singleSegment)
    requireBytes(windowLength + dictionaryLength + sizeLength)
    let windowSize = 0
    if (windowLength) {
      const windowDescriptor = buffer[cursor++]
      const windowBase = 2 ** (10 + (windowDescriptor >> 3))
      windowSize = windowBase + windowBase / 8 * (windowDescriptor & 7)
    }
    cursor += dictionaryLength
    let contentSize
    if (sizeLength) {
      contentSize = sizeLength === 8
        ? Number(buffer.readBigUInt64LE(cursor))
        : buffer.readUIntLE(cursor, sizeLength) + (sizeLength === 2 ? 256 : 0)
      cursor += sizeLength
    }
    if (singleSegment) windowSize = contentSize
    if (windowSize > MAX_FRAME_OUTPUT || contentSize > MAX_FRAME_OUTPUT) {
      throw new Error('frameSizeLimit')
    }
    let last
    do {
      requireBytes(3)
      const header = buffer.readUIntLE(cursor, 3)
      cursor += 3
      last = Boolean(header & 1)
      const type = (header >> 1) & 3
      const size = header >> 3
      if (type === 3 || size > Math.min(windowSize, 128 * 1024)) {
        throw new Error('invalidBlockHeader')
      }
      const storedSize = type === 1 ? 1 : size
      requireBytes(storedSize)
      cursor += storedSize
    } while (!last)
    if (descriptor & 4) {
      requireBytes(4)
      cursor += 4
    }
    let output
    try {
      output = zstdDecompressSync(buffer.subarray(start, cursor), { maxOutputLength: MAX_FRAME_OUTPUT })
    } catch {
      throw new Error('invalidCompressedFrame')
    }
    if (contentSize !== undefined && output.length !== contentSize) {
      throw new Error('invalidFrameContentSize')
    }
    yield output
  }
}
