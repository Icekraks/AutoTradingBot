import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import type { TradingEngine } from "../engine/trading-engine.js";
import { WSMessageType, type WSMessage, type SetModePayload } from "@trading-bot/shared";
import { config } from "../config.js";

function makeMessage<T>(type: WSMessageType, payload: T): string {
  const msg: WSMessage<T> = { type, payload, timestamp: Date.now() };
  return JSON.stringify(msg);
}

export function startWSServer(engine: TradingEngine): http.Server {
  const server = http.createServer((req, res) => {
    // Simple REST status endpoint
    if (req.url === "/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(engine.getSnapshot()));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("[WSServer] Client connected");

    // Send full snapshot on connect
    ws.send(makeMessage(WSMessageType.Snapshot, engine.getSnapshot()));

    // Forward engine events to this client
    const unsubscribe = engine.on((event) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      switch (event.type) {
        case "candle":
          ws.send(makeMessage(WSMessageType.CandleUpdate, { asset: event.asset, candle: event.candle }));
          break;
        case "regime":
          ws.send(makeMessage(WSMessageType.RegimeUpdate, { asset: event.asset, regime: event.regime }));
          break;
        case "order":
          ws.send(makeMessage(WSMessageType.OrderUpdate, { order: event.order }));
          break;
        case "portfolio":
          ws.send(makeMessage(WSMessageType.PortfolioUpdate, { portfolio: event.portfolio }));
          break;
        case "risk":
          ws.send(makeMessage(WSMessageType.RiskUpdate, { riskMetrics: event.metrics, brokerMetrics: event.brokerMetrics }));
          break;
        case "mode":
          ws.send(makeMessage(WSMessageType.ModeChange, { paperMode: event.paperMode }));
          break;
      }
    });

    // Handle messages from dashboard
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WSMessage;
        if (msg.type === WSMessageType.SetMode) {
          const { paperMode } = msg.payload as SetModePayload;
          engine.setMode(paperMode);
        }
      } catch (err) {
        console.warn("[WSServer] Invalid message:", err);
      }
    });

    ws.on("close", () => {
      unsubscribe();
      console.log("[WSServer] Client disconnected");
    });
  });

  server.listen(config.server.wsPort, () => {
    console.log(`[WSServer] Listening on port ${config.server.wsPort}`);
  });

  return server;
}
