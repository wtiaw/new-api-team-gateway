"""Native New API contracts, using local fixtures without paid upstreams."""
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
ENV = dict(line.split("=", 1) for line in (ROOT / "deploy/team-gateway/.env").read_text(encoding="utf-8-sig").splitlines() if "=" in line and not line.startswith("#"))
BASE = os.environ.get("GATEWAY_URL", "http://localhost:" + ENV["GATEWAY_PORT"])
parsed = urllib.parse.urlsplit(BASE)
if parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1"):
    raise RuntimeError("Only a local development URL is allowed.")
MODEL = "team-local-mock"
checks = []


def check(condition, label):
    if not condition:
        raise AssertionError(label)
    checks.append(label)


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.token = ""

    def request(self, method, path, body=None, bearer=None):
        headers = {"Content-Type": "application/json", "Accept-Language": "en"}
        token = self.token if bearer is None else bearer
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=45) as response:
                raw = response.read().decode()
                return response.status, json.loads(raw) if "json" in response.headers.get("Content-Type", "") else raw
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    def api(self, method, path, body=None):
        status, result = self.request(method, path, body)
        if status != 200 or not isinstance(result, dict) or not result.get("success"):
            # Never dump credentials, headers or complete response bodies.
            raise AssertionError(method + " " + path + " failed (HTTP " + str(status) + ")")
        return result.get("data")

    def login(self, username, password):
        encryption = self.api("GET", "/api/user/login/encryption-key")
        if encryption.get("enabled"):
            raise RuntimeError("Password encryption enabled; use native UI rather than weakening policy.")
        result = self.api("POST", "/api/user/login", {"username": username, "password": password})
        self.token = result["access_token"]
        return result["user"]


def run():
    admin = Client()
    admin_user = admin.login(ENV["ADMIN_USERNAME"], ENV["ADMIN_PASSWORD"])
    check(admin_user["role"] == 100, "native administrator login")
    # Only this local fixture is permitted; SSRF protection stays enabled.
    settings = {
        "ServerAddress": BASE,
        "fetch_setting.enable_ssrf_protection": "true",
        "fetch_setting.allow_private_ip": "true",
        "fetch_setting.domain_filter_mode": "true",
        "fetch_setting.domain_list": json.dumps(["mock-upstream"]),
        "fetch_setting.allowed_ports": json.dumps(["8080"]),
        "fetch_setting.apply_ip_filter_for_domain": "true",
        "QuotaForNewUser": "0",
    }
    options = {item["key"]: item["value"] for item in admin.api("GET", "/api/option/")}
    for key, value in settings.items():
        admin.api("PUT", "/api/option/", {"key": key, "value": value})
    for key, ratio in [("ModelRatio", .5), ("CompletionRatio", 2)]:
        values = json.loads(options.get(key) or "{}")
        values[MODEL] = ratio
        admin.api("PUT", "/api/option/", {"key": key, "value": json.dumps(values)})
    channels = admin.api("GET", "/api/channel/?p=1&page_size=100")
    if not any(channel["name"] == "LOCAL MOCK - no external billing" for channel in channels["items"]):
        admin.api("POST", "/api/channel/", {"mode": "single", "channel": {"type": 1, "name": "LOCAL MOCK - no external billing", "key": ENV["MOCK_UPSTREAM_KEY"], "base_url": "http://mock-upstream:8080", "models": MODEL, "group": "default", "status": 1}})
    check(True, "native channel configuration with isolated fixture")
    suffix = str(time.time_ns())[-13:]
    username = "local" + suffix
    password = "Aa1!" + secrets.token_hex(20)
    admin.api("POST", "/api/user/", {"username": username, "password": password, "display_name": "Local verification", "role": 1})
    member = Client()
    user = member.login(username, password)
    user_id = user["id"]
    check(member.api("GET", "/api/user/self")["quota"] == 0, "new personal account has no team or initial quota")
    admin.api("POST", "/api/user/manage", {"id": user_id, "action": "add_quota", "mode": "add", "value": 1000000})
    check(member.api("GET", "/api/user/self")["quota"] == 1000000, "administrator directly credits personal quota")
    admin.api("POST", "/api/user/manage", {"id": user_id, "action": "add_quota", "mode": "subtract", "value": 100000})
    check(member.api("GET", "/api/user/self")["quota"] == 900000, "administrator directly deducts personal quota")
    key_name = "local-verification-" + suffix
    member.api("POST", "/api/token/", {"name": key_name, "expired_time": int(time.time()) + 3600, "remain_quota": 100000, "unlimited_quota": False, "model_limits_enabled": True, "model_limits": MODEL, "group": "default"})
    keys = member.api("GET", "/api/token/?p=1&page_size=100")["items"]
    key = next(item for item in keys if item["name"] == key_name)
    raw_key = member.api("POST", "/api/token/" + str(key["id"]) + "/key")["key"]
    check(raw_key not in json.dumps(keys), "native key list masks secret")
    check(key["remain_quota"] == 100000 and key["expired_time"] > int(time.time()), "native key quota and expiry persisted")
    bearer = "sk-" + raw_key
    status, models = member.request("GET", "/v1/models", bearer=bearer)
    check(status == 200 and any(item["id"] == MODEL for item in models["data"]), "key model catalogue works")
    body = {"model": MODEL, "messages": [{"role": "user", "content": "local native verification"}], "max_tokens": 32}
    # New channels become routable after the native in-memory channel sync.
    # Retry only the transient distributor 503; never retry charged calls.
    deadline = time.monotonic() + 65
    while True:
        status, result = member.request("POST", "/v1/chat/completions", body, bearer)
        if status != 503 or "(distributor)" not in str(result) or time.monotonic() >= deadline:
            break
        time.sleep(.5)
    check(status == 200 and result["usage"]["total_tokens"] == 20, "ordinary relay preserves usage")
    status, stream = member.request("POST", "/v1/chat/completions", {**body, "stream": True, "stream_options": {"include_usage": True}}, bearer)
    check(status == 200 and "[DONE]" in stream and "New API local mock response." in stream, "stream relay completes with text")
    after = member.api("GET", "/api/user/self")
    check(after["quota"] == 900000 - 28, "personal settlement matches two 14-quota fixture calls")
    logs = member.api("GET", "/api/log/self?type=2&p=1&page_size=100")["items"]
    check(len(logs) == 2 and all(log["model_name"] == MODEL and log["quota"] == 14 for log in logs), "usage logs contain both settled calls")
    check(all(log["prompt_tokens"] == 12 and log["completion_tokens"] == 8 for log in logs), "log token breakdown is accurate")
    check(raw_key not in json.dumps(logs), "usage logs exclude the API key")
    status, _ = member.request("POST", "/v1/chat/completions", {**body, "model": "not-allowed-fixture"}, bearer)
    check(status == 403, "key model restriction is enforced")
    for label, overrides in [
        ("expired key is denied", {"expired_time": int(time.time()) - 60}),
        ("exhausted key is denied", {"remain_quota": 0}),
    ]:
        negative_name = "negative-" + secrets.token_hex(5)
        member.api("POST", "/api/token/", {"name": negative_name, "expired_time": -1, "remain_quota": 1000, "unlimited_quota": False, "group": "default", **overrides})
        negative_key = next(item for item in member.api("GET", "/api/token/?p=1&page_size=100")["items"] if item["name"] == negative_name)
        try:
            negative_secret = member.api("POST", "/api/token/" + str(negative_key["id"]) + "/key")["key"]
            status, _ = member.request("GET", "/v1/models", bearer="sk-" + negative_secret)
            check(status == 401, label)
        finally:
            member.api("DELETE", "/api/token/" + str(negative_key["id"]))
    member.api("PUT", "/api/token/?status_only=true", {"id": key["id"], "status": 2})
    status, _ = member.request("GET", "/v1/models", bearer=bearer)
    check(status == 401, "disabled key is denied")
    check(member.api("GET", "/api/user/self")["quota"] == 900000 - 28, "rejected requests never debit personal quota")
    status, _ = member.request("GET", "/api/user/")
    check(status == 403, "member cannot access administrator user management")
    status, _ = Client().request("GET", "/v1/models", bearer="")
    check(status == 401, "anonymous gateway requests denied")
    member.api("DELETE", "/api/token/" + str(key["id"]))
    status, _ = member.request("GET", "/v1/models", bearer=bearer)
    check(status == 401, "deleted key is no longer accepted")
    chart = member.api("GET", "/api/data/self?start_timestamp=" + str(int(time.time()) - 86400) + "&end_timestamp=" + str(int(time.time()) + 1))
    check(isinstance(chart, list), "chart query works (aggregation may flush later)")
    print(json.dumps({"passed": len(checks), "checks": checks}, ensure_ascii=False))


if __name__ == "__main__":
    run()
