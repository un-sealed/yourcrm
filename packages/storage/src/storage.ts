import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

export type StorageConfig = {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  forcePathStyle: boolean
}

export type PutInput = {
  key: string
  body: Uint8Array | string
  contentType?: string
}

/**
 * S3-compatible object storage abstraction. Binary bytes live here;
 * PostgreSQL stores only file metadata (spec 01-architecture).
 * Works against AWS S3 and local MinIO (path-style URLs).
 */
export class StorageService {
  private client: S3Client
  constructor(private config: StorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      forcePathStyle: config.forcePathStyle,
    })
  }

  get bucket(): string {
    return this.config.bucket
  }

  async put({ key, body, contentType }: PutInput): Promise<{ key: string }> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    )
    return { key }
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType?: string }> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    )
    const bytes = res.Body ? await res.Body.transformToByteArray() : new Uint8Array()
    return { body: bytes, contentType: res.ContentType }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
  }

  async presignedGet(key: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      {
        expiresIn,
      },
    )
  }

  async healthcheck(): Promise<{ ok: boolean; bucket: string }> {
    // Lightweight check: presign without network I/O so health works offline.
    await this.presignedGet("healthcheck.txt", 60)
    return { ok: true, bucket: this.config.bucket }
  }
}

export function storageConfigFromEnv(env: {
  STORAGE_ENDPOINT: string
  STORAGE_REGION: string
  STORAGE_BUCKET: string
  STORAGE_ACCESS_KEY: string
  STORAGE_SECRET_KEY: string
  STORAGE_FORCE_PATH_STYLE: boolean
}): StorageConfig {
  return {
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
  }
}
