import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "team-local-mock"
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def send_json(self, status, payload):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"status": "ok"})
        elif self.path == "/v1/models":
            self.send_json(200, {"object":"list", "data":[{"id":MODEL,"object":"model","owned_by":"local-test"}]})
        else:
            self.send_json(404, {"error":{"message":"unknown fixture endpoint"}})
    def do_POST(self):
        if self.headers.get("Authorization") != "Bearer " + os.environ["MOCK_UPSTREAM_KEY"]:
            return self.send_json(401, {"error":{"message":"invalid fixture key"}})
        if self.path not in ("/v1/chat/completions", "/v1/responses"):
            return self.send_json(404, {"error":{"message":"unknown fixture endpoint"}})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        except (ValueError, TypeError):
            return self.send_json(400, {"error":{"message":"invalid JSON"}})
        if body.get("model") != MODEL:
            return self.send_json(404, {"error":{"message":"unknown fixture model"}})
        if self.path == "/v1/responses":
            return self.send_responses(body)
        if body.get("tools") and not (body.get("max_tokens") or body.get("max_completion_tokens")):
            return self.send_json(400, {"error":{"message":"client tools require the reserved output bound on the wire"}})
        if any(message.get("content") == "force-error" for message in body.get("messages", [])):
            return self.send_json(500, {"error":{"message":"intentional local fixture failure","type":"server_error"}})
        usage = {"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}
        base = {"id":"chatcmpl-local-fixture","created":1793592000,"model":MODEL}
        if not body.get("stream"):
            return self.send_json(200, {**base,"object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"New API local mock response."},"finish_reason":"stop"}],"usage":usage})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        chunks = [
            {**base,"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"New API local mock response."},"finish_reason":None}]},
            {**base,"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":usage},
        ]
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def send_responses(self, body):
        if not isinstance(body.get("max_output_tokens"), int) or body["max_output_tokens"] < 8:
            return self.send_json(400, {"error":{"message":"fixture requires the quoted output bound on the actual wire"}})
        message = {"type":"message", "id":"msg_fixture", "status":"completed", "role":"assistant", "content":[{"type":"output_text", "text":"New API local mock response.", "annotations":[]}]}
        forced = body.get("tool_choice")
        output = {"type":"function_call", "id":"fc_fixture", "call_id":"call_fixture", "name":"read_file", "arguments":"{}", "status":"completed"} if isinstance(forced,dict) and forced.get("type")=="function" else message
        response = {"id":"resp_fixture", "object":"response", "created_at":1793592000, "model":MODEL, "status":"completed", "output":[output], "usage":{"input_tokens":12, "output_tokens":8, "total_tokens":20, "input_tokens_details":{"cached_tokens":0}}}
        if not body.get("stream"):
            return self.send_json(200, response)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        events = [
            {"type":"response.created", "response":{**response,"status":"in_progress","output":[],"usage":None}},
            {"type":"response.output_item.added", "output_index":0, "item":{**message,"content":[],"status":"in_progress"}},
            {"type":"response.content_part.added", "item_id":"msg_fixture", "output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}},
            {"type":"response.output_text.delta", "item_id":"msg_fixture", "output_index":0,"content_index":0,"delta":"New API local mock response."},
            {"type":"response.output_text.done", "item_id":"msg_fixture", "output_index":0,"content_index":0,"text":"New API local mock response."},
            {"type":"response.content_part.done", "item_id":"msg_fixture", "output_index":0,"content_index":0,"part":message["content"][0]},
            {"type":"response.output_item.done", "output_index":0, "item":message},
            {"type":"response.completed", "response":response},
        ]
        for number,event in enumerate(events):
            event["sequence_number"] = number
            self.wfile.write(("event: "+event["type"]+"\ndata: "+json.dumps(event)+"\n\n").encode())
            self.wfile.flush()

ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
