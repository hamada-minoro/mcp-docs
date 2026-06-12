import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function createS3Client(): S3Client {
  const endpoint = process.env.S3_ENDPOINT;
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

  return new S3Client({
    region: process.env.S3_REGION ?? "us-east-1",
    endpoint,
    forcePathStyle,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });
}

let _client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!_client) _client = createS3Client();
  return _client;
}

export function resetS3Client(): void {
  _client = null;
}

const BUCKET = () => process.env.S3_BUCKET!;

export async function uploadMarkdown(key: string, content: string): Promise<void> {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      Body: content,
      ContentType: "text/markdown; charset=utf-8",
    })
  );
}

export async function getMarkdownContent(key: string): Promise<string> {
  const client = getS3Client();
  const response = await client.send(
    new GetObjectCommand({ Bucket: BUCKET(), Key: key })
  );

  if (!response.Body) throw new Error("Arquivo não encontrado no storage.");

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function getPresignedDownloadUrl(
  key: string,
  expiresInSeconds = 300
): Promise<string> {
  const client = getS3Client();
  const command = new GetObjectCommand({ Bucket: BUCKET(), Key: key });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

export async function deleteObject(key: string): Promise<void> {
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
}

export async function objectExists(key: string): Promise<boolean> {
  const client = getS3Client();
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

export function buildS3Key(project: string, docId: string, filename: string): string {
  const safeProject = project.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `docs/${safeProject}/${docId}/${filename}`;
}
