import { resetS3Client } from "../src/storage/minio.js";

beforeEach(() => {
  resetS3Client();
});
