import sys, json, socket, struct, os, uuid, base64, time, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Configuration
CONFIG = {}
WS_SOCKET = None
HTTPD = None
SERVER_THREAD = None
SHUTDOWN_EVENT = threading.Event()

class AuthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global SHUTDOWN_EVENT
        parsed_path = urlparse(self.path)

        # Only handle /callback
        if parsed_path.path == '/callback':
            query_params = parse_qs(parsed_path.query)
            code = query_params.get('code', [None])[0]
            error = query_params.get('error', [None])[0]

            if code:
                send_neutralino_event('auth:code', {'code': code})
                self.send_response(200)
                self.send_header('Content-type', 'text/html')
                self.end_headers()
                self.wfile.write(b"<html><head><title>Login Successful</title></head><body style='font-family: sans-serif; text-align: center; margin-top: 50px;'><h1>Login Successful</h1><p>You can close this window and return to the app.</p><script>window.close();</script></body></html>")
            elif error:
                send_neutralino_event('auth:error', {'error': error})
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Login failed.")

            # Signal server to stop
            SHUTDOWN_EVENT.set()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        # Suppress default logging to stderr to keep neutralino output clean
        pass

def start_http_server():
    global HTTPD
    try:
        # Port 0 lets the OS pick a free port
        HTTPD = HTTPServer(('127.0.0.1', 0), AuthHandler)
        port = HTTPD.server_port
        send_neutralino_event('auth:ready', {'port': port})

        # Handle requests until shutdown is signaled
        while not SHUTDOWN_EVENT.is_set():
            HTTPD.handle_request()

    except Exception as e:
        send_neutralino_event('auth:error', {'message': str(e)})
    finally:
        if HTTPD:
            HTTPD.server_close()

def send_neutralino_event(event_name, data=None):
    if not WS_SOCKET: return
    try:
        # Construct the payload to broadcast an event to the app
        payload = {
            "method": "app.broadcast",
            "accessToken": CONFIG.get('nlToken'),
            "data": {
                "event": event_name,
                "data": data
            }
        }
        msg = json.dumps(payload)
        send_websocket_frame(WS_SOCKET, msg)
    except Exception as e:
        sys.stderr.write(f"Error sending event: {e}\n")

def send_websocket_frame(sock, message):
    payload = message.encode('utf-8')
    header = bytearray()
    header.append(0x81) # FIN + Text
    length = len(payload)

    if length <= 125:
        header.append(length | 0x80) # Masked
    elif length <= 65535:
        header.append(126 | 0x80)
        header.extend(struct.pack(">H", length))
    else:
        header.append(127 | 0x80)
        header.extend(struct.pack(">Q", length))

    mask = os.urandom(4)
    header.extend(mask)

    masked_payload = bytearray(length)
    for i in range(length):
        masked_payload[i] = payload[i] ^ mask[i % 4]

    sock.sendall(header + masked_payload)

def main():
    global CONFIG, WS_SOCKET, SHUTDOWN_EVENT, SERVER_THREAD

    # 1. Read config from stdin
    try:
        line = sys.stdin.readline()
        if not line: return
        CONFIG = json.loads(line)
    except: return

    ppid = os.getppid()

    # 2. Connect WebSocket
    try:
        WS_SOCKET = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        WS_SOCKET.settimeout(None)
        WS_SOCKET.connect(('127.0.0.1', int(CONFIG['nlPort'])))
    except Exception as e:
        sys.stderr.write(f"Failed to connect to Neutralino: {e}\n")
        return

    # 3. Handshake
    key = base64.b64encode(os.urandom(16)).decode()
    handshake = (
        f"GET /?extensionId={CONFIG['nlExtensionId']}&connectToken={CONFIG['nlConnectToken']} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{CONFIG['nlPort']}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    WS_SOCKET.sendall(handshake.encode())

    # Skip HTTP response header
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = WS_SOCKET.recv(1)
        if not chunk: break
        resp += chunk

    # 4. Main Loop
    while True:
        try:
            # Watchdog (Exit if parent dies)
            try:
                os.kill(ppid, 0)
            except OSError: break

            # Read WebSocket Frame
            # (Note: This is a simplified reader. For production, a robust frame parser is better,
            # but this works for standard Neutralino messages)
            head = WS_SOCKET.recv(2)
            if not head: break
            length = head[1] & 127
            if length == 126: length = struct.unpack(">H", WS_SOCKET.recv(2))[0]
            elif length == 127: length = struct.unpack(">Q", WS_SOCKET.recv(8))[0]

            data = b""
            while len(data) < length:
                chunk = WS_SOCKET.recv(length - len(data))
                if not chunk: break
                data += chunk

            if len(data) < length: break

            msg = json.loads(data.decode('utf-8'))

            # Handle Events
            if msg.get('event') == 'auth:start':
                # Reset shutdown event
                SHUTDOWN_EVENT.clear()
                # Start server in a thread
                if SERVER_THREAD and SERVER_THREAD.is_alive():
                    # Already running? Resend port if server is ready
                    if HTTPD:
                        send_neutralino_event('auth:ready', {'port': HTTPD.server_port})
                else:
                    SERVER_THREAD = threading.Thread(target=start_http_server, daemon=True)
                    SERVER_THREAD.start()

            elif msg.get('event') == 'windowClose':
                break

        except Exception as e:
            # sys.stderr.write(f"Error: {e}\n")
            # If socket fails, we probably should exit
            break

    # Cleanup
    SHUTDOWN_EVENT.set()
    if WS_SOCKET: WS_SOCKET.close()

if __name__ == "__main__":
    main()
