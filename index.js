const net = require('net')
const server = net.createServer()

const SERVER_PORT = process.env.PORT || 8080
const SERVER_HOST = process.env.HOST || '127.0.0.1'
const UPSTREAM_PORT = process.env.UPSTREAM_PORT || 9000
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || '127.0.0.1'
const PROXY_NAME = process.env.PROXY_NAME || 'Simple HTTP Proxy'

server.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`listening on ${server.address().address}:${server.address().port}`);
});

server.on('connection', socket => {
  const {
    address: clientAddress,
    port: clientPort,
  } = socket.address()
  socket.address = clientAddress
  socket.port = clientPort

  console.log(`client connected: \t${clientAddress}:${clientPort}`);

  socket.setEncoding('utf8');
  socket.on('data', forwardToUpstream.bind(global, socket))
  socket.on('end', () => console.log(`client disconnected: \t${clientAddress}:${clientPort}`))
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Error - Address in use`);
  }
  console.log(e);
});
server.on('close',() => {
  console.log(`Closed}`);
});

const parseHeader = kv => {
  const delimiter = kv.indexOf(':')
  const k = kv.slice(0, delimiter)
  const v = kv.slice(delimiter+1).trim()
  return { k, v }
}

const parsePayload = req => {

  const [unparsedHeaders, ...body] = req.split('\r\n\r\n')
  const [statusLine, ...headers] = unparsedHeaders.split('\r\n')
  let statusCode, httpVersion, path, method

  if (statusLine.startsWith('HTTP') ) {
    [httpVersion, statusCode] = statusLine.split(' ')
  } else {
    [method, path, httpVersion] = statusLine.split(' ')
  }

  return {
    statusLine,
    httpVersion,
    headers: headers.map(parseHeader).reduce((h, {k, v}) => ({ ...h, [k]:v}), {}),
    body: body.join('\r\n'),

    // requests
    method,
    path,

    // responses
    statusCode
  }
}

const encodeHeaders = headers => (encoded, name) =>
  `${encoded}\r\n${name}: ${headers[name]}`

const findHttpContentLength = payload => {
  let httpContentLength = null
  let contentLengthMatch = payload.match(/content-length: (\d+)\r\n/i)
  if(contentLengthMatch !== null){
    httpContentLength = parseInt(contentLengthMatch[1])
  }
  return httpContentLength
}

const addProxyHeader = headers => ({
  ...headers,
  'X-Proxy-Name': PROXY_NAME
})

const forwardToUpstream = (client, reqData) => {
  const { statusCode, headers, body } = parsePayload(reqData)
  // http request hooks:
  // caching
  // logging

  let upstreamPayload = ''
  let httpContentLength = null

  const backend  = new net.Socket();
  backend.setEncoding('utf8');
  backend.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    const {
      address: backendAddress,
      port: backendPort,
    } = backend.address()
    backend.address = backendAddress
    backend.port = backendPort

    console.log(`connection established with backend: \t${backendAddress}:${backendPort}`);

    // http request hooks:
    // transformations
    backend.write(reqData);
  });

  // response from backends
  backend.on('data', chunk => {
    upstreamPayload += chunk

    if( httpContentLength === null ) {
      httpContentLength = findHttpContentLength(upstreamPayload)
    }

    // close connection to backend
    let bodyLength = upstreamPayload.length - upstreamPayload.indexOf('\r\n\r\n')
    if( bodyLength >= (httpContentLength || Math.Infinity) && bodyLength <= upstreamPayload.length){
      backend.end()
    }
  });

  backend.on('end', () => {
    let {
      statusLine,
      headers: upstreamHeaders,
      body: upstreamBody,
    } = parsePayload(upstreamPayload)

    // http request hooks:
    // logging
    // transformations
    // compression

    let transformedHeaders = addProxyHeader(upstreamHeaders)

    let encodedTransformedHeaders = Object.keys(transformedHeaders)
      .reduce(encodeHeaders(transformedHeaders))

    // flush repsonse to client
    client.write(statusLine)
    client.write(encodedTransformedHeaders)
    client.write('\r\n\r\n')
    client.end(upstreamBody)

    console.log(`sent proxied response to client: \t${client.address}:${client.port}`);
    console.log(`backend connection closed: \t${backend.address}:${backend.port}`);
  });

}
