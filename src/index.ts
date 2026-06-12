import "dotenv/config";
import express from "express";
import { mcpRouter } from "./mcp/router.js";
import { authMiddleware } from "./auth/middleware.js";
import { prisma } from "./db/client.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "error", message: "Database unreachable" });
  }
});

app.use("/mcp", authMiddleware, mcpRouter);

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("[error]", err);
    res.status(500).json({ error: "Erro interno." });
  }
);

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const server = app.listen(PORT, () => {
  console.log(`MCP Docs Server rodando em http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});

process.on("SIGTERM", async () => {
  console.log("Encerrando servidor...");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

export { app };
