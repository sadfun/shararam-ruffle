import http from "node:http";

const port = Number.parseInt(process.argv[2] ?? "19090", 10);

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/login") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Fake official login</title>");
    return;
  }

  if (request.method === "POST" && request.url === "/api/user/loqin") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 0 }));
    return;
  }

  if (request.method === "GET" && request.url === "/game") {
    response.writeHead(302, { location: "/login/game" });
    response.end();
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Expired official mock: http://127.0.0.1:${port}`);
});
