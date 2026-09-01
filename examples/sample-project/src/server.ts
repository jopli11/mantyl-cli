import { createServer } from "node:http";
import { listNotes, addNote } from "./store.js";

// SEEDED QUIRK (undocumented env var): API_TOKEN is required here but is
// absent from .env.example and the README. Mantyl must surface it.
const API_TOKEN = process.env.API_TOKEN;
const PORT = Number(process.env.PORT ?? 3000);

export const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${API_TOKEN}`) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "GET" && req.url === "/notes") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listNotes()));
    return;
  }
  if (req.method === "POST" && req.url === "/notes") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      addNote(String(body));
      res.writeHead(201).end();
    });
    return;
  }
  res.writeHead(404).end();
});

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT);
}
