import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { LinkAddress, WebLinkTransport } from "../../src/links/check-web-link.js";
import {
  checkWebLink,
  isPublicLinkAddress,
  requestLinkAddress,
} from "../../src/links/check-web-link.js";
import { validateArtifactLinks } from "../../src/links/validate-artifact-links.js";
import { artifactLinks } from "../../src/protocol/artifact-links.js";

const publicAddress = { address: "93.184.216.34", family: 4 };
const signal = (): AbortSignal => AbortSignal.timeout(1_000);

test.each([
  "127.0.0.1",
  "0.1.2.3",
  "10.1.2.3",
  "100.64.1.1",
  "169.254.169.254",
  "172.16.1.1",
  "192.168.1.1",
  "192.0.2.1",
  "198.18.1.1",
  "224.1.2.3",
  "255.255.255.255",
  "::1",
  "fc00::1",
  "fe80::1",
  "::ffff:127.0.0.1",
  "64:ff9b::7f00:1",
  "2002:7f00:1::",
  "2001:db8::1",
  "3fff::1",
])("refuses nonpublic address %s", (address) => {
  expect(isPublicLinkAddress(address)).toBe(false);
});

test("accepts public IPv4 and IPv6", () => {
  expect(isPublicLinkAddress(publicAddress.address)).toBe(true);
  expect(isPublicLinkAddress("2606:4700:4700::1111")).toBe(true);
});

test("resolves once and passes the validated address into transport", async () => {
  let resolutions = 0;
  let sent: LinkAddress | undefined;
  const result = await checkWebLink("https://example.com/page", signal(), {
    resolve: async () =>
      ++resolutions === 1 ? [publicAddress] : [{ address: "127.0.0.1", family: 4 }],
    send: async (_url, address) => {
      sent = address;
      return { status: 200, location: undefined };
    },
  });
  expect(result.status).toBe("valid");
  expect(resolutions).toBe(1);
  expect(sent).toEqual(publicAddress);
});

test("private DNS answers and redirect rebinding never reach transport", async () => {
  for (const initialPrivate of [true, false]) {
    let resolutions = 0;
    let requests = 0;
    const result = await checkWebLink("https://example.com/page", signal(), {
      resolve: async () =>
        ++resolutions === 1 && !initialPrivate
          ? [publicAddress]
          : [{ address: "127.0.0.1", family: 4 }],
      send: async () => {
        requests++;
        return { status: 302, location: "/next" };
      },
    });
    expect(result.status).toBe("unverified");
    expect(requests).toBe(initialPrivate ? 0 : 1);
  }
});

test.each([200, 204, 404, 410, 403, 429, 500])("classifies HTTP %s", async (status) => {
  const transport: WebLinkTransport = {
    resolve: async () => [publicAddress],
    send: async () => ({ status, location: undefined }),
  };
  expect((await checkWebLink("https://example.com/", signal(), transport)).status).toBe(
    status < 300 ? "valid" : status === 404 || status === 410 ? "broken" : "unverified",
  );
});

test.each([
  "http://127.0.0.1/",
  "https://user:password@example.com/",
  "file:///etc/passwd",
  "javascript:alert(1)",
])("refuses redirect to %s", async (location) => {
  let requests = 0;
  const result = await checkWebLink("https://example.com/", signal(), {
    resolve: async () => [publicAddress],
    send: async () => {
      requests++;
      return { status: 302, location };
    },
  });
  expect(result.status).toBe("unverified");
  expect(requests).toBe(1);
});

test("bounds redirect loops and chains", async () => {
  for (const loop of [true, false]) {
    let requests = 0;
    const result = await checkWebLink("https://example.com/", signal(), {
      resolve: async () => [publicAddress],
      send: async () => ({ status: 302, location: loop ? "/" : `/next-${++requests}` }),
    });
    expect(result.status).toBe("unverified");
    expect(requests).toBeLessThanOrEqual(6);
  }
});

test("actual HTTP transport dials the supplied address and retains Host", async () => {
  let host: string | undefined;
  const server = createServer((request, response) => {
    host = request.headers.host;
    response.writeHead(200);
    response.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server port");
  try {
    const result = await requestLinkAddress(
      new URL(`http://does-not-resolve.invalid:${address.port}/`),
      { address: "127.0.0.1", family: 4 },
      signal(),
    );
    expect(result.status).toBe(200);
    expect(host).toBe(`does-not-resolve.invalid:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("inert link parsing validates targets and deduplicates HTTP checks", () => {
  expect(
    artifactLinks(
      '<a href="#a%20b">x</a><h2 id="a b">Heading</h2><a name="legacy" href="#legacy">old</a><a href="#top">top</a><a href="#">top</a><a href="https://EXAMPLE.com:443/x#one">one</a><a href="https://example.com/x#two">two</a><template><a href="#missing">inert</a></template>',
    ),
  ).toEqual({ urls: ["https://example.com/x"] });
  for (const html of [
    '<a href="#missing">bad</a>',
    '<a href="#x">bad</a><p id="x"></p><p id="x"></p>',
    '<a href="/relative">bad</a>',
    '<a href="javascript:alert(1)">bad</a>',
    '<a href="#%FF">bad</a>',
  ]) {
    expect(artifactLinks(html)).toMatchObject({
      verdict: "refused",
      issue: "artifact-link-invalid",
    });
  }
});

test("caps distinct links without truncation", () => {
  expect(
    artifactLinks(
      Array.from({ length: 101 }, (_, i) => `<a href="https://example.com/${i}">link</a>`).join(""),
    ),
  ).toMatchObject({ verdict: "refused" });
});

test("checks at most four links concurrently and reports the first failure in document order", async () => {
  let active = 0;
  let peak = 0;
  const html = Array.from(
    { length: 9 },
    (_, i) => `<a href="https://example.com/${i}">link</a>`,
  ).join("");
  const result = await validateArtifactLinks(html, signal(), async (url) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return { status: "broken", reason: `HTTP 404 for ${url}` };
  });
  expect(peak).toBe(4);
  expect(result?.message).toContain("https://example.com/0");
});

test("cancellation ends hung probes and never claims success", async () => {
  const controller = new AbortController();
  const checking = validateArtifactLinks(
    '<a href="https://example.com/">x</a>',
    controller.signal,
    () => new Promise(() => {}),
  );
  controller.abort();
  expect(await checking).toMatchObject({ issue: "artifact-link-unverified", verdict: "refused" });
});

test("pinned transport does not follow an environment proxy", async () => {
  let proxyRequests = 0;
  const proxy = createServer((_request, response) => {
    proxyRequests++;
    response.writeHead(502);
    response.end();
  });
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end();
  });

  await Promise.all([
    new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
  ]);

  const proxyAddress = proxy.address();
  const serverAddress = server.address();
  if (
    !proxyAddress ||
    typeof proxyAddress === "string" ||
    !serverAddress ||
    typeof serverAddress === "string"
  )
    throw new Error("missing port");

  try {
    // Subprocess isolation: Bun can retain proxy configuration after restoration,
    // so we run the transport probe in a child process with isolated environment.
    const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
    const destinationUrl = `http://proxy-test.invalid:${serverAddress.port}/`;
    const sourceFile = new URL("../../src/links/check-web-link.js", import.meta.url).href;

    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { requestLinkAddress } from "${sourceFile}"; const r = await requestLinkAddress(new URL("${destinationUrl}"), { address: "127.0.0.1", family: 4 }, AbortSignal.timeout(1000)); console.log(JSON.stringify(r));`,
      ],
      {
        env: {
          ...Bun.env,
          HTTP_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          NO_PROXY: "",
          no_proxy: "",
        },
        stdio: ["inherit", "pipe", "pipe"],
      },
    );

    const [exitCode, stdoutText, stderrText] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdoutText);
    expect(result.status).toBe(200);
    expect(proxyRequests).toBe(0);
  } finally {
    proxy.closeAllConnections();
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
  }
});

test.each([
  {
    response: "HTTP/1.1 103 Early Hints\r\nLink: </style>\r\n\r\nHTTP/1.1 200 OK\r\n\r\n",
    valid: true,
  },
  { response: `HTTP/1.1 200 OK\r\nX-Huge: ${"x".repeat(17_000)}\r\n\r\n`, valid: false },
  { response: "HTTP/1.1 302 Found\r\nLocation: /one\r\nLocation: /two\r\n\r\n", valid: false },
])(
  "bounded header probe handles informational and ambiguous responses %#",
  async ({ response, valid }) => {
    const { createServer: createTcpServer } = await import("node:net");
    const server = createTcpServer((socket) => socket.once("data", () => socket.end(response)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server port");
    try {
      const pending = requestLinkAddress(
        new URL(`http://example.com:${address.port}/`),
        { address: "127.0.0.1", family: 4 },
        signal(),
      );
      if (valid) expect((await pending).status).toBe(200);
      else await expect(pending).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
