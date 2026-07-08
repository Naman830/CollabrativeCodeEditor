require("dotenv").config();

const { WebSocketServer } = require("ws");
const { handleYjsConnection } = require("./yjsConnection");

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", handleYjsConnection);

console.log(`Yjs sync WebSocket server listening on port ${PORT}`);

// sim
