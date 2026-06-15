import { Router, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools.js";
import { auditLog } from "../utils/audit.js";

const router = Router();

const sessions = new Map<string, StreamableHTTPServerTransport>();

function createMcpServer(req: Request): McpServer {
  const server = new McpServer({
    name: "DevVault",
    version: "1.0.0",
  });

  registerTools(server, {
    userId: req.authUser!.id,
    apiKeyId: req.authApiKey!.id,
    scopes: req.authApiKey!.scopes,
    allowedProjects: req.authApiKey!.allowedProjects,
  });

  return server;
}

router.post("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  try {
    if (sessionId && sessions.has(sessionId)) {
      transport = sessions.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      const server = createMcpServer(req);
      await server.connect(transport);

      await auditLog({
        userId: req.authUser?.id,
        apiKeyId: req.authApiKey?.id,
        action: "mcp.session.created",
        ipAddress: req.socket.remoteAddress,
        userAgent: req.headers["user-agent"],
        result: "success",
      });
    } else {
      res.status(400).json({ error: "Sessão inválida ou ausente." });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[mcp] Erro no handler POST:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erro interno no servidor MCP." });
    }
  }
});

router.get("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Sessão não encontrada." });
    return;
  }

  const transport = sessions.get(sessionId)!;
  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("[mcp] Erro no handler GET (SSE):", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erro no stream SSE." });
    }
  }
});

router.delete("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId)!;
    try {
      await transport.close();
    } catch {
      // ignore close errors
    }
    sessions.delete(sessionId);

    await auditLog({
      userId: req.authUser?.id,
      apiKeyId: req.authApiKey?.id,
      action: "mcp.session.closed",
      ipAddress: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      result: "success",
    });
  }

  res.status(204).send();
});

export { router as mcpRouter };
