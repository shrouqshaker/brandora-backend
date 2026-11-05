import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ErrorCode } from '../../common/errors/error-code';
import { fail } from '../product-access.service';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const CLOUDINARY_TIMEOUT_MS = 30000;
export interface ImageAsset {
  secureUrl: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
}

export function imageFile(file: Express.Multer.File | undefined) {
  if (!file?.buffer?.length)
    fail(
      ErrorCode.PRODUCT_IMAGE_INVALID,
      HttpStatus.BAD_REQUEST,
      'An image file is required',
    );
  const b = file.buffer;
  if (b.length > MAX_IMAGE_BYTES)
    fail(
      ErrorCode.PRODUCT_IMAGE_TOO_LARGE,
      HttpStatus.PAYLOAD_TOO_LARGE,
      'Image exceeds 5 MB',
    );
  const jpg = b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png =
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp =
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP';
  const mime = jpg
    ? 'image/jpeg'
    : png
      ? 'image/png'
      : webp
        ? 'image/webp'
        : null;
  if (!mime || file.mimetype !== mime)
    fail(
      ErrorCode.PRODUCT_IMAGE_INVALID,
      HttpStatus.BAD_REQUEST,
      'Only matching JPEG, PNG or WebP files are accepted',
    );
  return { buffer: b, mime };
}

@Injectable()
export class CloudinaryService {
  constructor(private readonly config: ConfigService) {}

  private settings() {
    const cloud = this.config.get<string>('CLOUDINARY_CLOUD_NAME') ?? '';
    const key = this.config.get<string>('CLOUDINARY_API_KEY') ?? '';
    const secret = this.config.get<string>('CLOUDINARY_API_SECRET') ?? '';
    if (
      !/^[a-zA-Z0-9_-]+$/.test(cloud) ||
      !/^\d+$/.test(key) ||
      !secret.trim() ||
      /\s/.test(secret)
    )
      fail(
        ErrorCode.PRODUCT_IMAGE_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        'Image storage is not configured',
      );
    return { cloud, key, secret };
  }

  assertReady() {
    this.settings();
  }

  private async request(
    action: 'upload' | 'destroy',
    parameters: Record<string, string>,
    file?: ReturnType<typeof imageFile>,
  ) {
    const { cloud, key, secret } = this.settings();
    const params = {
      ...parameters,
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    // Cloudinary signed Upload API: sorted parameters + secret, SHA-256.
    const signature = createHash('sha256')
      .update(
        Object.entries(params)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join('&') + secret,
      )
      .digest('hex');
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.set(k, v);
    form.set('api_key', key);
    form.set('signature', signature);
    if (file)
      form.set(
        'file',
        new Blob([new Uint8Array(file.buffer)], { type: file.mime }),
        'image',
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOUDINARY_TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${cloud}/image/${action}`,
        {
          method: 'POST',
          body: form,
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) throw new Error();
        parts.push(value);
      }
      const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error();
      return { value: value as Record<string, unknown>, cloud };
    } catch {
      fail(
        ErrorCode.PRODUCT_IMAGE_UNAVAILABLE,
        HttpStatus.BAD_GATEWAY,
        'Image storage request failed',
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async upload(
    publicId: string,
    file: ReturnType<typeof imageFile>,
  ): Promise<ImageAsset> {
    const { value: v, cloud } = await this.request(
      'upload',
      {
        public_id: publicId,
        overwrite: 'false',
        allowed_formats: 'jpg,png,webp',
      },
      file,
    );
    const secureUrl = typeof v.secure_url === 'string' ? v.secure_url : '';
    let validUrl = false;
    try {
      const u = new URL(secureUrl);
      validUrl =
        u.origin === 'https://res.cloudinary.com' &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname.startsWith(`/${cloud}/image/upload/`);
    } catch {
      /* invalid provider metadata */
    }
    if (
      v.public_id !== publicId ||
      v.resource_type !== 'image' ||
      !validUrl ||
      secureUrl.length > 1000 ||
      !['jpg', 'png', 'webp'].includes(v.format as string) ||
      ![v.width, v.height, v.bytes].every(
        (n) => Number.isInteger(n) && Number(n) > 0 && Number(n) <= 2147483647,
      ) ||
      Number(v.bytes) > MAX_IMAGE_BYTES ||
      Number(v.width) * Number(v.height) > 25000000
    )
      fail(
        ErrorCode.PRODUCT_IMAGE_UNAVAILABLE,
        HttpStatus.BAD_GATEWAY,
        'Invalid image storage response',
      );
    return {
      secureUrl,
      width: Number(v.width),
      height: Number(v.height),
      bytes: Number(v.bytes),
      format: v.format as string,
    };
  }

  async destroy(publicId: string) {
    const { value } = await this.request('destroy', {
      public_id: publicId,
      invalidate: 'true',
    });
    if (!['ok', 'not found'].includes(value.result as string))
      fail(
        ErrorCode.PRODUCT_IMAGE_UNAVAILABLE,
        HttpStatus.BAD_GATEWAY,
        'Image deletion failed',
      );
    return value.result as 'ok' | 'not found';
  }
}
