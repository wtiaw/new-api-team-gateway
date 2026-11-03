"""Isolated three-database acceptance. No deployment .env or paid upstreams.

Run scripts/team-gateway/test-databases.ps1. Only tgtest-* projects are removed.
Credentials and API keys are deliberately excluded from evidence output.
"""
import argparse
import csv
import http.cookiejar
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MODEL = "team-local-mock"
DEEPSEEK_MODEL = "deepseek-local-mock"
OLD_IMAGE = "calciumion/new-api:v1.0.0-rc.47@sha256:938fa2713d4946723c9e9ce3076351c33f7770699fec92d23f3a26fd95791026"
GO_IMAGE = "golang:1.26.10-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308"
MYSQL_IMAGE = "mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b"


def require(condition, label):
    if not condition:
        raise AssertionError(redact(label))


def redact(value):
    return re.sub(r"(/api/team-invitations/)[A-Za-z0-9_-]+", r"\1[redacted]", value)


def settled_quota(client, expected):
    # Native relay responds before its deferred accounting goroutine completes.
    deadline = time.monotonic() + 10
    while True:
        actual = client.api("GET", "/api/user/self")["quota"]
        if actual == expected or time.monotonic() >= deadline:
            return actual
        time.sleep(.05)


def settled_balance(client, path, expected):
    deadline = time.monotonic() + 10
    while True:
        actual = client.api("GET", path)["team"]["balance"]
        if actual == expected or time.monotonic() >= deadline:
            return actual
        time.sleep(.05)


def wait_ready(base):
    deadline = time.monotonic() + 180
    while True:
        try:
            if Client(base).request("GET", "/api/status")[0] == 200:
                return
        except (OSError, urllib.error.URLError):
            pass
        require(time.monotonic() < deadline, "app startup timeout")
        time.sleep(1)


class Client:
    def __init__(self, base):
        parsed = urllib.parse.urlsplit(base)
        require(parsed.hostname in ("localhost", "127.0.0.1"), "local test URL required")
        require(parsed.port != 18310, "live gateway port is forbidden")
        self.base = base
        self.token = ""
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, method, path, body=None, bearer=None):
        token = self.token if bearer is None else bearer
        headers = {"Content-Type": "application/json", "Accept-Language": "en"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            self.last_headers = response.headers
            raw = response.read().decode()
            try:
                result = json.loads(raw)
            except ValueError:
                result = raw
            return response.status, result

    def api(self, method, path, body=None):
        status, result = self.request(method, path, body)
        require(status == 200 and isinstance(result, dict) and result.get("success"), method + " " + path + " failed (HTTP " + str(status) + ")")
        return result.get("data")

    def denied(self, method, path, body=None):
        status, result = self.request(method, path, body)
        require(status in (400, 401, 403, 404, 409) or (isinstance(result, dict) and result.get("success") is False), "unauthorized operation accepted: " + method + " " + path)

    def login(self, username, password):
        result = self.api("POST", "/api/user/login", {"username": username, "password": password})
        self.token = result["access_token"]
        return result["user"]


def initialize(base, password):
    admin = Client(base)
    setup = admin.api("GET", "/api/setup")
    if not setup["status"]:
        admin.api("POST", "/api/setup", {"username": "testroot", "password": password, "confirmPassword": password})
    admin.login("testroot", password)
    return admin


def configure(admin):
    options = {x["key"]: x["value"] for x in admin.api("GET", "/api/option/")}
    settings = {"QuotaForNewUser": "0", "fetch_setting.enable_ssrf_protection": "true", "fetch_setting.allow_private_ip": "true", "fetch_setting.domain_filter_mode": "true", "fetch_setting.domain_list": json.dumps(["mock-upstream"]), "fetch_setting.allowed_ports": "[8080]", "fetch_setting.apply_ip_filter_for_domain": "true"}
    for key, ratio in [("ModelRatio", .5), ("CompletionRatio", 2)]:
        values = json.loads(options.get(key) or "{}")
        values[MODEL] = ratio
        values[DEEPSEEK_MODEL] = ratio
        settings[key] = json.dumps(values)
    for key, value in settings.items():
        admin.api("PUT", "/api/option/", {"key": key, "value": value})
    channels = admin.api("GET", "/api/channel/?p=1&page_size=100")["items"]
    if not channels:
        admin.api("POST", "/api/channel/", {"mode": "single", "channel": {"type": 1, "name": "Acceptance local fixture", "key": "isolated-acceptance-upstream-key", "base_url": "http://mock-upstream:8080", "models": MODEL, "group": "default", "status": 1}})
        admin.api("POST", "/api/channel/", {"mode": "single", "channel": {"type": 43, "name": "Acceptance DeepSeek same-group fixture", "key": "isolated-acceptance-upstream-key", "base_url": "http://mock-upstream:8080", "models": DEEPSEEK_MODEL, "model_mapping": json.dumps({DEEPSEEK_MODEL: MODEL}), "group": "default", "status": 1}})


def user(admin, name):
    password = "Aa1!" + secrets.token_hex(16)
    admin.api("POST", "/api/user/", {"username": name, "password": password, "role": 1, "display_name": "Acceptance"})
    client = Client(admin.base)
    info = client.login(name, password)
    return client, info


def token(client, name, **extra):
    client.api("POST", "/api/token/", {"name": name, "expired_time": -1, "remain_quota": 100000, "unlimited_quota": False, "model_limits_enabled": True, "model_limits": MODEL, "group": "default", **extra})
    item = next(x for x in client.api("GET", "/api/token/?p=1&page_size=100")["items"] if x["name"] == name)
    secret = client.api("POST", "/api/token/" + str(item["id"]) + "/key")["key"]
    return item, "sk-" + secret


def relay(client, bearer, **extra):
    body = {"model": MODEL, "messages": [{"role": "user", "content": "test"}], "max_tokens": 32, **extra}
    deadline = time.monotonic() + 70
    while True:
        status, result = client.request("POST", "/v1/chat/completions", body, bearer)
        if status != 503 or "(distributor)" not in str(result) or time.monotonic() >= deadline:
            return status, result
        time.sleep(.5)


def seed(admin):
    configure(admin)
    member, info = user(admin, "legacyuser")
    require(info["quota"] == 0, "new personal account starts empty")
    admin.api("POST", "/api/user/manage", {"id": info["id"], "action": "add_quota", "mode": "add", "value": 1000100})
    admin.api("POST", "/api/user/manage", {"id": info["id"], "action": "add_quota", "mode": "subtract", "value": 100})
    require(member.api("GET", "/api/user/self")["quota"] == 1000000, "system directly credits and debits personal wallet")
    item, bearer = token(member, "legacy-preserved")
    status, result = relay(member, bearer)
    require(status == 200 and result["usage"]["total_tokens"] == 20, "legacy fixture relay")
    require(settled_quota(member, 1000000 - 14) == 1000000 - 14, "legacy 14 quota billing")
    info = member.api("GET", "/api/user/self")
    logs = member.api("GET", "/api/log/self?type=2&p=1&page_size=100")["items"]
    require(len(logs) == 1 and logs[0]["quota"] == 14, "legacy consume log")
    return {"user_id": info["id"], "quota": info["quota"], "key_id": item["id"], "log_id": logs[0]["id"], "client": member, "bearer": bearer}


def verify_legacy(admin, snapshot):
    info = admin.api("GET", "/api/user/" + str(snapshot["user_id"]))
    require(info["quota"] == snapshot["quota"], "upgrade preserves exact personal quota")
    keys = snapshot["client"].api("GET", "/api/token/?p=1&page_size=100")["items"]
    require(any(x["id"] == snapshot["key_id"] and x["name"] == "legacy-preserved" for x in keys), "upgrade preserves existing native key")
    require(snapshot["client"].request("GET", "/v1/models", bearer=snapshot["bearer"])[0] == 200, "existing native key authenticates after restart")
    # Native admin log API verifies the separately configured log database too.
    logs = admin.api("GET", "/api/log/?type=2&p=1&page_size=100")["items"]
    require(any(x["user_id"] == snapshot["user_id"] and x["token_id"] == snapshot["key_id"] and x["quota"] == 14 and x["prompt_tokens"] == 12 and x["completion_tokens"] == 8 for x in logs), "upgrade preserves original consume log")


def team_smoke(admin, expire):
    # Intentionally fails on the pinned original release: team routes are new.
    teams = admin.api("GET", "/api/teams")
    require(isinstance(teams, (dict, list)), "team list API contract")
    manager, manager_info = user(admin, "manager")
    member, member_info = user(admin, "member")
    other, other_info = user(admin, "other")
    require(member.api("GET", "/api/user/self")["quota"] == 0, "new user has zero personal quota")
    key, bearer = token(member, "team-spending")
    policy = "/api/team-key-policies/" + str(key["id"])
    require(member.api("GET", policy)["mode"] == "legacy", "a user without a team keeps personal/native funding")
    team = admin.api("POST", "/api/teams", {"name": "Acceptance A", "admin_user_id": manager_info["id"], "daily_limit": None, "weekly_limit": None})
    require(team["allow_personal_backup"] is True, "new team allows personal backup by explicit server default")
    team2 = admin.api("POST", "/api/teams", {"name": "Acceptance B", "admin_user_id": other_info["id"]})
    path = "/api/teams/" + str(team["id"])
    foreign = "/api/teams/" + str(team2["id"])
    manager.denied("POST", "/api/teams", {"name": "forbidden"})
    manager.denied("GET", foreign)
    manager.denied("PUT", foreign, {"name": "forbidden"})
    manager.denied("GET", foreign + "/members")
    manager.denied("GET", foreign + "/usage")
    manager.denied("GET", foreign + "/overview")
    manager.denied("GET", foreign + "/quota")
    manager.denied("POST", path + "/quota", {"mode": "add", "value": 1, "reason": "forbidden", "operation_id": "forbidden"})
    manager.denied("POST", "/api/user/manage", {"id": member_info["id"], "action": "add_quota", "mode": "add", "value": 1})
    manager.denied("GET", "/api/log/?type=2&p=1&page_size=100")
    invite = manager.api("POST", path + "/invitations", {"valid_days": 7})
    invpath = "/api/team-invitations/" + invite["token"]
    preview = member.api("GET", invpath)
    require(preview["state"] == "active", "invitation active preview")
    joined = member.api("POST", invpath + "/accept")
    repeated = member.api("POST", invpath + "/accept")
    require(joined["id"] == repeated["id"], "same-user acceptance is idempotent")
    accepted_invites = manager.api("GET", path + "/invitations")
    accepted_invite = next(row for row in accepted_invites if row["id"] == invite["invitation"]["id"])
    require(accepted_invite["accepted_username"] == member_info["username"] and accepted_invite["used_at"] > 0, "manager invitation list identifies the accepting username and time")
    require(all("token_hash" not in row and "token" not in row for row in accepted_invites), "invitation list never leaks invitation credentials")
    member.denied("GET", path + "/invitations")
    require(member.api("GET", invpath)["accepted_by_current_user"] is True and other.api("GET", invpath)["accepted_by_current_user"] is False, "invitation preview distinguishes current user's redemption")
    other.denied("POST", invpath + "/accept")
    require(member.api("GET", "/api/user/self")["quota"] == 0, "join preserves empty personal wallet")
    member.denied("POST", path + "/invitations", {"valid_days": 7})
    member.denied("GET", path + "/quota")
    member.denied("PUT", path, {"daily_limit": 0})
    manager.denied("PUT", path + "/members/" + str(member_info["id"]), {"role": "admin"})
    revoked = manager.api("POST", path + "/invitations", {"valid_days": 1})
    manager.api("DELETE", path + "/invitations/" + str(revoked["invitation"]["id"]))
    other.denied("POST", "/api/team-invitations/" + revoked["token"] + "/accept")
    expired = manager.api("POST", path + "/invitations", {"valid_days": 1})
    expire(expired["invitation"]["id"])
    expired_path = "/api/team-invitations/" + expired["token"]
    require(other.api("GET", expired_path)["state"] == "expired", "expired invitation preview")
    other.denied("POST", expired_path + "/accept")
    operation = {"mode": "add", "value": 1000000, "reason": "acceptance funding", "operation_id": "acceptance-fund"}
    first = admin.api("POST", path + "/quota", operation)
    again = admin.api("POST", path + "/quota", operation)
    require(first["id"] == again["id"], "wallet operation idempotency")
    admin.denied("POST", path + "/quota", {**operation, "value": 2})
    admin.api("POST", path + "/quota", {**operation, "mode": "subtract", "value": 100, "operation_id": "acceptance-debit"})
    admin.api("POST", path + "/quota", {**operation, "value": 100, "operation_id": "acceptance-recredit"})
    require(manager.api("GET", path)["team"]["balance"] == 1000000, "system directly credits team wallet")
    member_detail = member.api("GET", path)
    member_list = next(row for row in member.api("GET", "/api/teams") if row["id"] == team["id"])
    require("balance" not in member_detail["team"] and "budget" not in member_detail and "balance" not in member_list, "member list and detail APIs exclude shared wallet and global consumption")
    require(manager.api("GET", "/api/user/self")["role"] == 1, "team manager remains native ordinary user")
    effective = member.api("GET", policy)
    require(effective["mode"] == "team_first" and effective["team_id"] == team["id"] and effective["is_default"], "an existing unconfigured key inherits its joined team without manual setup")
    listed_key = next(item for item in member.api("GET", "/api/token/?p=1&page_size=100")["items"] if item["id"] == key["id"])
    require(listed_key["funding_policy"]["mode"] == "team_first", "native key list includes the effective default policy")
    manager.api("PUT", path, {"daily_limit": 1000000, "weekly_limit": 2000000})
    chat_tools = [{"type":"function","function":{"name":"read_file","parameters":{"type":"object","properties":{}}}}]
    chat_messages = [{"role":"user","content":[{"type":"text","text":"hi"}]}]
    status, result = relay(member, bearer, messages=chat_messages, tools=chat_tools, max_tokens=None)
    require(status == 200 and result["usage"]["total_tokens"] == 20, "team key works with zero personal balance")
    require(member.api("GET", "/api/user/self")["quota"] == 0, "team relay never debits personal wallet")
    require(settled_balance(manager, path, 1000000 - 14) == 1000000 - 14, "team relay charges actual 14 quota")
    manager.api("PUT", path, {"daily_limit": 1000000, "weekly_limit": 2000000})
    # Production models use expressions rather than the older ratio fixture.
    # Preserve the same actual 14-quota charge, while exercising cache/tier quotes.
    admin.api("PUT", "/api/option/", {"key": "billing_setting.billing_expr", "value": json.dumps({MODEL: 'len <= 272000 ? tier("short", p * 1 + cr * 0.1 + cc * 1.25 + cc12h * 2.5 + c * 2) : tier("long", p * 2 + cr * 0.2 + cc * 2.5 + cc12h * 5 + c * 4)'})})
    admin.api("PUT", "/api/option/", {"key": "billing_setting.billing_mode", "value": json.dumps({MODEL: "tiered_expr"})})
    for streaming in (False, True):
        pg_body = {"model": MODEL, "group": "default", "messages": [{"role": "user", "content": "playground acceptance"}], "stream": streaming, "stream_options": {"include_usage": True}}
        if streaming:
            pg_body.update({"tools":chat_tools,"messages":[*chat_messages,{"role":"assistant","content":None,"tool_calls":[{"id":"call_chat","type":"function","function":{"name":"read_file","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call_chat","content":"fixture text"}],"response_format":{"type":"json_object"}})
        pg_status, pg_result = member.request("POST", "/pg/chat/completions", pg_body)
        require(pg_status == 200, "expression-priced playground uses team funds with zero personal quota and hard limits")
        if streaming:
            require(isinstance(pg_result, str) and "data: [DONE]" in pg_result and '"total_tokens":20' in pg_result.replace(" ", ""), "expression-priced playground streams actual usage")
        else:
            require(pg_result["usage"]["total_tokens"] == 20, "expression-priced playground returns actual usage")
    require(settled_balance(manager, path, 1000000 - 42) == 1000000 - 42, "both playground calls settle actual expression-priced charges")
    require(member.api("GET", "/api/user/self")["quota"] == 0, "playground never debits the empty personal wallet")
    # Shape taken from the installed DSH Responses adapter: message arrays,
    # developer instructions, function schemas, store:false and tool replay.
    dsh_body = {"model": MODEL, "input": [{"role":"developer","content":"You are a local test assistant."},{"role":"user","content":[{"type":"input_text","text":"hi"}]}], "tools":[{"type":"function","name":"read_file","description":"Read a fixture", "parameters":{"type":"object","properties":{}},"strict":False}], "store":False, "stream":False, "tool_choice":{"type":"function","name":"read_file"}}
    response_status,response_result = member.request("POST", "/v1/responses", dsh_body, bearer)
    require(response_status == 200 and response_result["output"][0]["type"] == "function_call", "DSH message arrays and client functions work without an explicit output limit")
    replay = {**dsh_body,"input":[*dsh_body["input"],{"type":"reasoning","encrypted_content":"codex-opaque-fixture"},{"type":"compaction","encrypted_content":"codex-compaction-fixture"},response_result["output"][0],{"type":"function_call_output","call_id":"call_fixture","output":"fixture text"}],"tool_choice":"auto","stream":True,"max_output_tokens":128,"text":{"format":{"type":"text"}}}
    response_status,response_result = member.request("POST", "/v1/responses", replay, bearer)
    require(response_status == 200 and isinstance(response_result,str) and '"type":"response.completed"' in response_result.replace(" ","") and '"total_tokens":20' in response_result.replace(" ",""), "DSH tool result replay completes through native Responses SSE")
    require(settled_balance(manager, path, 1000000 - 70) == 1000000 - 70, "DSH and opaque Codex context settle actual token costs")
    require(member.api("GET", "/api/user/self")["quota"] == 0, "DSH team calls preserve the empty personal wallet")
    # Keep expression pricing active while denying a fully exhausted team budget.
    manager.api("PUT", path, {"daily_limit": 0, "weekly_limit": 2000000})
    denied_status, denied_result = member.request("POST", "/pg/chat/completions", {"model": MODEL, "group": "default", "messages": [{"role": "user", "content": "denied at daily cap"}], "stream": False})
    require(denied_status == 403, "expression-priced playground preserves the hard daily limit with no personal balance")
    require(member.request("POST","/v1/responses",dsh_body,bearer)[0] == 403, "DSH request cannot exceed the exhausted team daily limit")
    require(manager.api("GET", path)["team"]["balance"] == 1000000 - 70, "rejected expression request leaves team wallet unchanged")
    admin.api("PUT", "/api/option/", {"key": "billing_setting.billing_mode", "value": json.dumps({MODEL: "ratio"})})
    manager.api("PUT", path, {"daily_limit": None, "weekly_limit": None})
    admin.api("POST", path + "/quota", {"mode": "add", "value": 56, "reason": "restore playground and DSH acceptance charges for following fixtures", "operation_id": "playground-fixture-restore"})
    member.denied("PUT", policy, {"mode": "team_only", "team_id": team2["id"]})
    admin.api("POST", "/api/user/manage", {"id": member_info["id"], "action": "add_quota", "mode": "add", "value": 1000000})
    member.api("PUT", policy, {"mode": "team_first", "team_id": team["id"]})
    admin.api("PUT", path, {"allow_personal_backup": False})
    manager.denied("PUT", path, {"allow_personal_backup": True})
    member.denied("PUT", policy, {"mode": "team_first", "team_id": team["id"]})
    require(relay(member, bearer)[0] == 403, "system backup revocation blocks previously saved automatic policy")
    require(manager.api("GET", path)["team"]["balance"] == 1000000 - 14 and member.api("GET", "/api/user/self")["quota"] == 1000000, "revoked backup policy never debits either wallet")
    admin.api("PUT", path, {"allow_personal_backup": True})
    for limit in ("daily_limit", "weekly_limit"):
        manager.api("PUT", path, {"daily_limit": None, "weekly_limit": None, limit: 0})
        member.api("PUT", policy, {"mode": "team_only", "team_id": team["id"]})
        before = member.api("GET", "/api/user/self")["quota"]
        require(relay(member, bearer)[0] != 200, "strict team does not fall back when " + limit + " exhausted")
        require(member.api("GET", "/api/user/self")["quota"] == before, "rejected strict request never debits personal wallet")
        member.api("PUT", policy, {"mode": "team_first", "team_id": team["id"]})
        require(relay(member, bearer)[0] == 200, "automatic personal fallback on " + limit)
        require(settled_quota(member, before - 14) == before - 14, "fallback settles personal 14 quota")
        require(manager.api("GET", path)["team"]["balance"] == 1000000 - 14, "personal fallback leaves team unchanged")
    manager.api("PUT", path, {"daily_limit": None, "weekly_limit": None})
    require(relay(member, bearer)[0] == 200, "team-first returns to restored team source")
    require(settled_balance(manager, path, 1000000 - 28) == 1000000 - 28, "restored source charged exactly once")
    before_failed_personal = member.api("GET", "/api/user/self")["quota"]
    require(relay(member, bearer, messages=[{"role": "user", "content": "force-error"}])[0] == 500, "local upstream failure is returned")
    require(settled_balance(manager, path, 1000000 - 28) == 1000000 - 28, "upstream failure refunds original team wallet")
    require(member.api("GET", "/api/user/self")["quota"] == before_failed_personal, "upstream failure never falls back to personal wallet")
    failed_usage = manager.api("GET", path + "/usage")
    require(any(row["state"] == "refunded" and row["source"] == "team" and row["user_id"] == member_info["id"] for row in failed_usage), "failed request has durable original-team refund snapshot")
    member.api("PUT", policy, {"mode": "personal_first", "team_id": team["id"]})
    require(relay(member, bearer)[0] == 200, "personal-first charges available personal source")
    require(settled_quota(member, 1000000 - 42) == 1000000 - 42, "personal-first exact charge")
    require(manager.api("GET", path)["team"]["balance"] == 1000000 - 28, "personal-first leaves team unchanged")
    member.api("PUT", policy, {"mode": "personal_only", "team_id": 0})
    manager.api("PUT", path, {"daily_limit": 0, "weekly_limit": 0})
    require(relay(member, bearer)[0] == 200, "personal-only has no team daily or weekly limit")
    require(settled_quota(member, 1000000 - 56) == 1000000 - 56, "personal-only exact charge")
    manager.api("PUT", path, {"daily_limit": None, "weekly_limit": None})
    manager_key, manager_bearer = token(manager, "manager-spending", model_limits=MODEL + "," + DEEPSEEK_MODEL)
    manager.api("PUT", "/api/team-key-policies/" + str(manager_key["id"]), {"mode": "team_only", "team_id": team["id"]})
    stream_status, stream_result = relay(manager, manager_bearer, stream=True, stream_options={"include_usage": True})
    require(stream_status == 200 and "[DONE]" in stream_result, "second member streams using shared team wallet")
    require(settled_balance(manager, path, 1000000 - 42) == 1000000 - 42, "multiple members and keys use one shared wallet")
    models_status, listed_models = manager.request("GET", "/v1/models", bearer=manager_bearer)
    require(models_status == 200 and {MODEL, DEEPSEEK_MODEL} <= {row["id"] for row in listed_models["data"]}, "one group and API key list both GPT-compatible and DeepSeek provider models")
    require(relay(manager, manager_bearer, model=DEEPSEEK_MODEL)[0] == 200, "same API key routes to DeepSeek channel within the shared group")
    require(settled_balance(manager, path, 1000000 - 56) == 1000000 - 56, "mixed-provider requests debit the same team wallet")
    require(relay(member, bearer, model="not-allowed-fixture")[0] == 403, "native model restrictions remain enforced")
    saved_key = next(x for x in member.api("GET", "/api/token/?p=1&page_size=100")["items"] if x["id"] == key["id"])
    require(saved_key["remain_quota"] == 100000 - 112, "native cumulative key quota includes team, DSH Responses and personal spending")
    member.api("PUT", policy, {"mode": "team_only", "team_id": team["id"]})
    member.api("PUT", "/api/token/?status_only=true", {"id": key["id"], "status": 2})
    require(relay(member, bearer)[0] == 401, "native disabled key remains rejected")
    usage = manager.api("GET", path + "/usage")
    own_usage = member.api("GET", path + "/usage")
    require(isinstance(usage, list) and any(row["user_id"] == manager_info["id"] for row in usage) and any(row["user_id"] == member_info["id"] for row in usage), "team manager reads all members' settled usage rows")
    require(isinstance(own_usage, list) and all(row["user_id"] == member_info["id"] for row in own_usage), "member own usage privacy")
    for client, expected_scope, expected_rows in ((manager, "team", usage), (member, "mine", own_usage)):
        overview = client.api("GET", path + "/overview")
        settled = [row for row in expected_rows if row["state"] == "settled"]
        require(overview["scope"] == expected_scope and overview["days"] == 7 and len(overview["trend"]) == 7, "overview defaults to seven Shanghai calendar days with authorized scope")
        expected = {"requests": len(expected_rows), "settled_requests": len(settled), "actual": sum(row["actual"] for row in settled), "prompt_tokens": sum(row["prompt_tokens"] for row in settled), "completion_tokens": sum(row["completion_tokens"] for row in settled)}
        require(all(overview["summary"][key] == value for key, value in expected.items()), "overview agrees with exact authorized ledger totals excluding refunded spend and personal funding")
        require(all(sum(row[key] for row in overview["trend"]) == value and sum(row[key] for row in overview["models"]) == value for key, value in expected.items()), "overview daily and model breakdowns reconcile to summary")
        require(len(client.api("GET", path + "/overview?days=30")["trend"]) == 30, "overview thirty-day selection zero-fills the full period")
        client.denied("GET", path + "/overview?days=8")
    for selected_id in (manager_info["id"], member_info["id"]):
        filtered = manager.api("GET", path + "/overview?days=30&user_id=" + str(selected_id))
        selected_rows = [row for row in usage if row["user_id"] == selected_id]
        amount = sum(row["actual"] for row in selected_rows if row["state"] == "settled")
        require(filtered["scope"] == "member" and filtered["member_id"] == selected_id and filtered["summary"]["requests"] == len(selected_rows), "manager member filter selects exactly the intended history")
        require(filtered["summary"]["actual"] == amount and sum(row["actual"] for row in filtered["trend"]) == amount and sum(row["actual"] for row in filtered["models"]) == amount, "filtered daily trend, model breakdown and summary reconcile")
        require({row["user_id"] for row in filtered["members"]} == {manager_info["id"], member_info["id"]}, "member filter options remain complete when a member is selected")
    require("members" not in member.api("GET", path + "/overview"), "ordinary member overview never exposes other member options")
    member.denied("GET", path + "/overview?user_id=" + str(manager_info["id"]))
    manager.denied("GET", path + "/overview?user_id=" + str(other_info["id"]))
    for invalid_filter in ("abc", "-1", "1.5", "999999999999999999999999"):
        manager.denied("GET", path + "/overview?user_id=" + invalid_filter)
    first_page = manager.api("GET", path + "/usage?page=1&page_size=1")
    second_page = manager.api("GET", path + "/usage?page=2&page_size=1")
    require(first_page["total"] == len(usage) and len(first_page["items"]) == 1 and len(second_page["items"]) == 1, "server usage pagination returns totals and bounded pages")
    require(first_page["items"][0]["request_id"] != second_page["items"][0]["request_id"], "pagination returns distinct history rows")
    private_page = member.api("GET", path + "/usage?page=1&page_size=500")
    require(private_page["total"] == len(own_usage) and all(row["user_id"] == member_info["id"] for row in private_page["items"]), "paged usage preserves ordinary member privacy")
    manager.denied("GET", foreign + "/usage/export")
    for client, own_only in ((manager, False), (member, True)):
        status, exported = client.request("GET", path + "/usage/export")
        require(status == 200 and "text/csv" in client.last_headers.get("Content-Type", "") and "attachment" in client.last_headers.get("Content-Disposition", ""), "usage export has downloadable CSV headers")
        rows = list(csv.DictReader(io.StringIO(exported.lstrip("\ufeff"))))
        require(len(rows) == (len(own_usage) if own_only else len(usage)), "CSV exports complete authorized history")
        require(not own_only or all(int(row["user_id"]) == member_info["id"] for row in rows), "member CSV excludes other members' usage")
    budget = manager.api("GET", path)["budget"]
    require(budget["daily_used"] == 112 and budget["weekly_used"] == 112 and budget["daily_reserved"] == 0 and budget["weekly_reserved"] == 0, "only settled API and playground team spending consumes team cycle limits; personal payments and refunds do not")
    manager.api("PUT", path, {"daily_limit": 2500000, "weekly_limit": 12500000})
    member_detail = member.api("GET", path)
    require(member_detail["team"]["daily_limit"] == 2500000 and member_detail["team"]["weekly_limit"] == 12500000 and "balance" not in member_detail["team"] and "budget" not in member_detail, "member receives five-dollar daily and twenty-five-dollar weekly ceilings without shared remaining funds")
    manager.api("DELETE", path + "/members/" + str(member_info["id"]))
    removed_history = manager.api("GET", path + "/overview?user_id=" + str(member_info["id"]))
    require(removed_history["summary"]["requests"] == len(own_usage) and any(row["user_id"] == member_info["id"] for row in removed_history["members"]), "removed member remains selectable for their historical usage")
    require(all(row["user_id"] != member_info["id"] for row in manager.api("GET", path + "/members")), "removed member is hidden rather than displayed as disabled")
    member.denied("GET", path)
    member.denied("GET", path + "/overview")
    require(member.api("GET", "/api/user/self")["quota"] == 1000000 - 56, "removal preserves personal wallet")
    return {"team_id": team["id"], "balance": 1000000 - 56, "usage_count": len(usage), "member_id": member_info["id"], "member_quota": 1000000 - 56, "checks": ["legacy preservation", "team management permissions", "cross-team isolation", "invitation expiry replay and revocation", "wallet idempotency", "zero personal team relay", "system personal-backup policy revocation", "daily and weekly fallback", "strict source rejection", "failed upstream refunds original source", "four funding policies", "native key restrictions", "member usage privacy", "server history pagination and scoped CSV export", "scoped overview totals and trends", "mixed-provider group model listing and same-key routing", "membership removal preserves quota"]}


def per_member_allowance_smoke(admin):
    manager, info_a = user(admin, "allowance-a")
    member, info_b = user(admin, "allowance-b")
    team = admin.api("POST", "/api/teams", {"name":"Per-member allowance", "admin_user_id":info_a["id"], "daily_limit":14, "weekly_limit":28})
    path = "/api/teams/" + str(team["id"])
    invitation = manager.api("POST", path + "/invitations", {"valid_days":7})
    member.api("POST", "/api/team-invitations/" + invitation["token"] + "/accept")
    admin.api("POST", path + "/quota", {"mode":"add", "value":200, "reason":"isolated member allowance fixture", "operation_id":"member-allowance-fund"})
    key_a, bearer_a = token(manager, "member-allowance-a")
    key_b, bearer_b = token(member, "member-allowance-b")
    policy_a = "/api/team-key-policies/" + str(key_a["id"])
    policy_b = "/api/team-key-policies/" + str(key_b["id"])
    for client,policy in ((manager,policy_a),(member,policy_b)):
        client.api("PUT", policy, {"mode":"team_only", "team_id":team["id"]})
    require(relay(manager,bearer_a)[0] == 200, "member A consumes their own daily allowance")
    require(settled_balance(manager,path,186) == 186, "member A daily charge has committed before the next admission")
    require(relay(manager,bearer_a)[0] == 403, "member A is blocked at their own daily cap")
    require(relay(member,bearer_b)[0] == 200, "member B retains their own daily allowance after A is exhausted")
    require(settled_balance(manager,path,172) == 172, "both independent allowances debit one shared team wallet")
    admin.api("POST", "/api/user/manage", {"id":info_a["id"], "action":"add_quota", "mode":"add", "value":1000000})
    manager.api("PUT", policy_a, {"mode":"team_first", "team_id":team["id"]})
    require(relay(manager,bearer_a)[0] == 200, "exhausted member A can use their own personal backup")
    require(settled_quota(manager,1000000-14) == 1000000-14, "personal backup is independent of both member allowances")
    manager.api("PUT", path, {"daily_limit":None})
    manager.api("PUT", policy_a, {"mode":"team_only", "team_id":team["id"]})
    require(relay(manager,bearer_a)[0] == 200, "member A reaches their own weekly cap")
    require(settled_balance(manager,path,158) == 158, "member A weekly charge has committed")
    require(relay(manager,bearer_a)[0] == 403, "member A weekly cap blocks A only")
    require(relay(member,bearer_b)[0] == 200, "member B retains a separate weekly allowance")
    require(settled_balance(manager,path,144) == 144, "member B weekly charge has committed")
    require(relay(member,bearer_b)[0] == 403, "member B stops after reaching their own weekly cap")
    require(settled_balance(manager,path,144) == 144, "weekly spending reconciles to shared funds")
    detail=manager.api("GET",path)
    require(detail["budget"]["weekly_used"] == 56, "admin aggregate usage can exceed a single member cap without disabling everyone")
    for uid in (info_a["id"],info_b["id"]):
        scoped=manager.api("GET",path+"/overview?user_id="+str(uid))
        require(scoped["period_usage"]["weekly_used"] == 28, "overview returns each member's own weekly spending")


def postpaid_smoke(admin):
    member, info = user(admin, "postpaid")
    team = admin.api("POST", "/api/teams", {"name": "Postpaid acceptance", "admin_user_id": info["id"], "daily_limit": 5, "weekly_limit": 5})
    path = "/api/teams/" + str(team["id"])
    admin.api("POST", path + "/quota", {"mode": "add", "value": 5, "reason": "postpaid fixture", "operation_id": "postpaid-fund"})
    key, bearer = token(member, "Codex postpaid")
    policy = "/api/team-key-policies/" + str(key["id"])
    member.api("PUT", policy, {"mode": "team_only", "team_id": team["id"]})
    body = {"model": MODEL, "input": [{"type": "reasoning", "encrypted_content": "codex-opaque-fixture"}, {"type": "compaction", "encrypted_content": "codex-compaction-fixture"}, {"role": "user", "content": "hello"}], "store": False, "stream": False, "tools": [{"type": "web_search"}]}
    status, result = member.request("POST", "/v1/responses", body, bearer)
    require(status == 200, "opaque Codex context and hosted tools pass team funding without a prequote")
    require(settled_balance(member, path, -9) == -9, "postpaid actual 14 charge is allowed to overdraw the positive five-quota balance")
    detail = member.api("GET", path)
    require(detail["budget"]["daily_used"] == 14 and detail["budget"]["weekly_used"] == 14, "actual daily and weekly usage includes the overage")
    require(member.request("POST", "/v1/responses", body, bearer)[0] == 403, "subsequent team request is blocked after settlement exceeds limits")
    admin.api("POST", "/api/user/manage", {"id": info["id"], "action": "add_quota", "mode": "add", "value": 1000000})
    member.api("PUT", policy, {"mode": "team_first", "team_id": team["id"]})
    require(relay(member, bearer)[0] == 200, "exhausted postpaid source follows the selected personal backup policy")
    require(settled_quota(member, 1000000 - 14) == 1000000 - 14, "backup charges only personal funds")
    member.api("PUT", path, {"daily_limit": None, "weekly_limit": None})
    member.api("PUT", policy, {"mode": "team_only", "team_id": team["id"]})
    require(relay(member, bearer)[0] == 403, "negative balance blocks new team requests even without period limits")
    admin.api("POST", path + "/quota", {"mode": "add", "value": 14, "reason": "clear debt", "operation_id": "postpaid-refill"})
    require(relay(member, bearer, messages=[{"role": "user", "content": "force-error"}])[0] == 500, "upstream errors are returned without changing source")
    require(settled_balance(member, path, 5) == 5, "failed postpaid request leaves the team balance intact")
    rows = member.api("GET", path + "/usage?page=1&page_size=100")["items"]
    require(all(row["username"] == info["username"] and row["token_name"] == key["name"] for row in rows), "paginated history returns usernames and key names")
    require(any(row["state"] == "refunded" for row in rows), "zero-reservation failure has a durable refund record")
    named = member.api("GET", path + "/usage?page=1&search=" + urllib.parse.quote(key["name"]))
    require(named["total"] == len(rows), "usage supports searching by key name")
    require(member.api("GET", "/api/user/self")["quota"] == 1000000 - 14, "postpaid team settlement keeps personal money independent")


def channel_pricing_smoke(admin):
    member, info = user(admin, "pricing-member")
    models = ["pricing-a", "pricing-b", "pricing-c"]
    ratios = dict(json.loads(next(x["value"] for x in admin.api("GET", "/api/option/") if x["key"] == "ModelRatio")))
    completions = dict(json.loads(next(x["value"] for x in admin.api("GET", "/api/option/") if x["key"] == "CompletionRatio")))
    for name in models:
        ratios[name] = 5
        completions[name] = 2
    admin.api("PUT", "/api/option/", {"key":"ModelRatio", "value":json.dumps(ratios)})
    admin.api("PUT", "/api/option/", {"key":"CompletionRatio", "value":json.dumps(completions)})
    group_key="group_ratio_setting.group_ratio"
    options=admin.api("GET", "/api/option/")
    original_group=next((x["value"] for x in options if x["key"]==group_key), '{"default":1}')
    groups=json.loads(original_group)
    groups["default"]=1
    admin.api("PUT", "/api/option/", {"key":group_key,"value":json.dumps(groups)})
    for name,factor in zip(models,(0.3,0.5,1)):
        admin.api("POST", "/api/channel/", {"mode":"single","channel":{"type":1,"name":name,"key":"isolated-acceptance-upstream-key","base_url":"http://mock-upstream:8080","models":name,"model_mapping":json.dumps({name:MODEL}),"group":"default","status":1,"setting":json.dumps({"sales_multiplier":factor})}})
    team=admin.api("POST", "/api/teams", {"name":"Pricing acceptance","admin_user_id":info["id"],"daily_limit":1000000,"weekly_limit":2000000})
    path="/api/teams/"+str(team["id"])
    admin.api("POST",path+"/quota",{"mode":"add","value":1000000,"reason":"isolated pricing fixture","operation_id":"pricing-fixture"})
    key,bearer=token(member,"pricing",model_limits=",".join(models))
    member.api("PUT","/api/team-key-policies/"+str(key["id"]),{"mode":"team_only","team_id":team["id"]})
    balance=1000000
    for name,expected in zip(models,(42,70,140)):
        status,result=relay(member,bearer,model=name)
        require(status==200,"channel price team relay: "+name)
        balance-=expected
        require(settled_balance(member,path,balance)==balance,"channel factor actually affects team charge: "+name)
    # Existing group controls multiply the channel price rather than replace it.
    groups["default"]=0.5
    admin.api("PUT","/api/option/",{"key":group_key,"value":json.dumps(groups)})
    require(relay(member,bearer,model=models[0])[0]==200,"group and channel combined relay")
    balance-=21
    require(settled_balance(member,path,balance)==balance,"0.3 channel x 0.5 group charges 0.15x")
    logs=member.api("GET","/api/log/self?type=2&p=1&page_size=100")["items"]
    matching=[row for row in logs if row["model_name"]==models[0] and row["quota"]==21]
    require(len(matching)==1,"native consume log uses final multiplied charge")
    factors=json.loads(matching[0]["other"])
    require(factors["channel_sales_multiplier"]==0.3 and factors["base_group_ratio"]==0.5 and factors["effective_price_multiplier"]==0.15,"native log retains both price factors")
    # Expression pricing follows the same contract.
    admin.api("PUT","/api/option/",{"key":"billing_setting.billing_expr","value":json.dumps({models[0]:'tier("base", p * 10 + c * 20)'})})
    admin.api("PUT","/api/option/",{"key":"billing_setting.billing_mode","value":json.dumps({models[0]:"tiered_expr"})})
    require(relay(member,bearer,model=models[0])[0]==200,"expression channel pricing relay")
    balance-=21
    require(settled_balance(member,path,balance)==balance,"expression pricing includes channel and group factors")
    member.api("PUT",path,{"daily_limit":1})
    require(relay(member,bearer,model=models[0])[0]==403,"discounted channel cannot bypass team daily limit")
    require(member.api("GET","/api/user/self")["quota"]==0,"channel pricing preserves separate personal wallet")
    admin.api("PUT","/api/option/",{"key":group_key,"value":original_group})
    return {"team_id":team["id"],"balance":balance,"channels":models}


def command(args, env, evidence, name):
    result = subprocess.run(args, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    (evidence / (name + ".log")).write_text(redact(result.stdout), encoding="utf-8")
    require(result.returncode == 0, name + " failed; inspect local evidence")
    return result.stdout.strip()


def matrix(args):
    require(args.port != 18310, "live gateway port forbidden")
    engines = ["sqlite", "mysql", "postgres"] if args.engine == "all" else [args.engine]
    scenarios = ["fresh", "upgrade"] if args.scenario == "all" else [args.scenario]
    run_id = time.strftime("%Y%m%d%H%M%S") + secrets.token_hex(2)
    evidence = ROOT / ".artifacts/database-acceptance" / run_id
    evidence.mkdir(parents=True)
    env = dict(os.environ)
    args.image = command(["docker", "image", "inspect", args.image, "--format", "{{.Id}}"], env, evidence, "application-image")
    # Keep the resolved image named while another build retags :local. A bare
    # dangling image ID can otherwise disappear during unrelated build cleanup.
    runtime_image = "new-api-team-gateway:acceptance-" + run_id
    command(["docker", "tag", args.image, runtime_image], env, evidence, "pin-application-image")
    env.update(TEST_PORT=str(args.port), TEST_APP_IMAGE=runtime_image)
    results = []
    for engine in engines:
        for scenario in scenarios:
            project = "tgtest-" + run_id + "-" + engine + "-" + scenario
            case = evidence / (engine + "-" + scenario)
            case.mkdir()
            compose = ["docker", "compose", "--env-file", "NUL", "-p", project, "-f", str(ROOT / "deploy/team-gateway/compose.test.yaml")]
            password = "Aa1!" + secrets.token_hex(16)
            env.update(TEST_SQL_DSN="", TEST_LOG_SQL_DSN="", TEST_APP_IMAGE=OLD_IMAGE if scenario == "upgrade" else runtime_image)
            try:
                services = ["redis", "mock-upstream"] + ([engine] if engine != "sqlite" else [])
                command(compose + ["up", "-d", "--wait", "--wait-timeout", "240"] + services, env, case, "infra")
                if engine == "postgres":
                    for db in ("acceptance_logs", "acceptance_models"):
                        command(compose + ["exec", "-T", "postgres", "createdb", "-U", "acceptance", db], env, case, "create-" + db)
                    env["TEST_SQL_DSN"] = "postgresql://acceptance:acceptance-isolated-only@postgres:5432/acceptance"
                    env["TEST_LOG_SQL_DSN"] = env["TEST_SQL_DSN"].replace(":5432/acceptance", ":5432/acceptance_logs")
                    command(compose + ["exec", "-T", "postgres", "postgres", "--version"], env, case, "version")
                elif engine == "mysql":
                    command(compose + ["exec", "-T", "-e", "MYSQL_PWD=acceptance-isolated-only", "mysql", "mysql", "-uroot", "-e", "CREATE DATABASE acceptance_logs; CREATE DATABASE acceptance_models;"], env, case, "create-databases")
                    env["TEST_SQL_DSN"] = "root:acceptance-isolated-only@tcp(mysql:3306)/acceptance?charset=utf8mb4&parseTime=True&loc=Local"
                    env["TEST_LOG_SQL_DSN"] = env["TEST_SQL_DSN"].replace("/acceptance?", "/acceptance_logs?")
                    command(compose + ["exec", "-T", "mysql", "mysqld", "--version"], env, case, "version")
                def indexes(startup):
                    if engine == "sqlite":
                        query = "import sqlite3; c=sqlite3.connect('/data/acceptance.db'); print('\\n'.join(r[0] for r in c.execute(\"SELECT name || '|' || tbl_name || '|' || coalesce(sql,'') FROM sqlite_master WHERE type='index' ORDER BY name\")))"
                        inspect = ["docker", "run", "--rm", "-v", project + "_app-data:/data:ro", "python:3.12-alpine@sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31", "python", "-c", query]
                    elif engine == "mysql":
                        sql = "SELECT CONCAT(TABLE_SCHEMA,'|',TABLE_NAME,'|',INDEX_NAME,'|',COLUMN_NAME,'|',NON_UNIQUE,'|',SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA IN ('acceptance','acceptance_logs') ORDER BY TABLE_SCHEMA,TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX"
                        inspect = compose + ["exec", "-T", "-e", "MYSQL_PWD=acceptance-isolated-only", "mysql", "mysql", "-uroot", "-N", "-B", "-e", sql]
                    else:
                        sql = "SELECT tablename || '|' || indexname || '|' || indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname"
                        main = command(compose + ["exec", "-T", "postgres", "psql", "-U", "acceptance", "-d", "acceptance", "-t", "-A", "-c", sql], env, case, "indexes-main-" + str(startup))
                        log = command(compose + ["exec", "-T", "postgres", "psql", "-U", "acceptance", "-d", "acceptance_logs", "-t", "-A", "-c", sql], env, case, "indexes-log-" + str(startup))
                        return set(main.splitlines()) | {"log:" + x for x in log.splitlines()}
                    return set(command(inspect, env, case, "indexes-" + str(startup)).splitlines())
                for startup in range(3 if scenario == "upgrade" else 2):
                    if startup:
                        env["TEST_APP_IMAGE"] = runtime_image
                    command(compose + ["up", "-d", "--force-recreate", "--no-deps", "app"], env, case, "startup-" + str(startup))
                    base = "http://127.0.0.1:" + str(args.port)
                    wait_ready(base)
                    admin = initialize(base, password)
                    if startup == 0:
                        snapshot = seed(admin)
                        original_indexes = indexes(startup)
                    else:
                        verify_legacy(admin, snapshot)
                        require(original_indexes <= indexes(startup), "startup preserves original database indexes and uniqueness definitions")
                    command(compose + ["logs", "--no-color", "app"], env, case, "migration-" + str(startup))
                if not args.skip_model_tests:
                    dsn = env["TEST_SQL_DSN"].replace(":5432/acceptance", ":5432/acceptance_models").replace("/acceptance?", "/acceptance_models?")
                    go = ["docker", "run", "--rm", "--network", project + "_default", "-e", "TEAM_TEST_DSN=" + dsn, "-e", "TEAM_TEST_DIALECT=" + engine, "-e", "GOWORK=off", "-e", "GOMAXPROCS=2", "-v", str(ROOT) + ":/source", "-v", "new-api-team-gateway-gomod:/go/pkg/mod", "-v", "new-api-team-gateway-gocache:/root/.cache/go-build", "-w", "/source", GO_IMAGE, "go", "test", "./model", "-run", "TestTeam", "-count=1", "-v"]
                    command(go, env, case, "model-tests")
                    # Native role-change fixtures intentionally require loopback.
                    # Share only the isolated SQL container's network namespace;
                    # never relax that safety check or use the live gateway DB.
                    controller_go = go.copy()
                    controller_go[controller_go.index("-run") + 1] = "TestManageUserDemote|TestTeamDemotionConcurrent"
                    controller_go[controller_go.index("./model")] = "./controller"
                    controller_go[controller_go.index("-w"):controller_go.index("-w")] = ["-e", "TEST_MANAGE_USER_DIALECT=" + engine]
                    if engine != "sqlite":
                        sql_container = command(compose + ["ps", "-q", engine], env, case, "controller-sql-container").strip()
                        controller_go[controller_go.index("--network") + 1] = "container:" + sql_container
                        loopback_dsn = dsn.replace("tcp(mysql:3306)", "tcp(127.0.0.1:3306)").replace("@postgres:5432/", "@127.0.0.1:5432/")
                        controller_go[controller_go.index("-w"):controller_go.index("-w")] = ["-e", "TEST_" + engine.upper() + "_DSN=" + loopback_dsn]
                    command(controller_go, env, case, "controller-demotion-tests")
                def expire(invitation_id):
                    sql = "UPDATE team_invitations SET expires_at=1 WHERE id=" + str(int(invitation_id))
                    if engine == "sqlite":
                        mutation = ["docker", "run", "--rm", "-v", project + "_app-data:/data", "python:3.12-alpine@sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31", "python", "-c", "import sqlite3; c=sqlite3.connect('/data/acceptance.db'); c.execute('" + sql + "'); c.commit()"]
                    elif engine == "mysql":
                        mutation = compose + ["exec", "-T", "-e", "MYSQL_PWD=acceptance-isolated-only", "mysql", "mysql", "-uroot", "acceptance", "-e", sql]
                    else:
                        mutation = compose + ["exec", "-T", "postgres", "psql", "-U", "acceptance", "-d", "acceptance", "-c", sql]
                    command(mutation, env, case, "expire-test-invitation")
                team_snapshot = team_smoke(admin, expire)
                per_member_allowance_smoke(admin)
                postpaid_smoke(admin)
                pricing_snapshot = channel_pricing_smoke(admin)
                team_indexes = indexes("with-team-data")
                command(compose + ["up", "-d", "--force-recreate", "--no-deps", "app"], env, case, "restart-with-team-data")
                wait_ready(base)
                admin = initialize(base, password)
                verify_legacy(admin, snapshot)
                require(admin.api("GET", "/api/teams/"+str(pricing_snapshot["team_id"]))["team"]["balance"]==pricing_snapshot["balance"],"restart preserves channel-priced team balance")
                for channel in admin.api("GET", "/api/channel/?p=1&page_size=100")["items"]:
                    if channel["name"] in pricing_snapshot["channels"]:
                        require(json.loads(channel["setting"])["sales_multiplier"] in (0.3,0.5,1),"restart preserves channel multiplier JSON")
                team_path = "/api/teams/" + str(team_snapshot["team_id"])
                require(admin.api("GET", team_path)["team"]["balance"] == team_snapshot["balance"], "restart preserves team wallet")
                require(len(admin.api("GET", team_path + "/usage")) == team_snapshot["usage_count"], "restart preserves funding snapshots")
                require(admin.api("GET", "/api/user/" + str(team_snapshot["member_id"]))["quota"] == team_snapshot["member_quota"], "restart preserves independent personal wallet")
                require(team_indexes <= indexes("after-team-restart"), "restart preserves all team uniqueness definitions")
                results.append({"engine": engine, "scenario": scenario, "success": True, "checks": team_snapshot["checks"] + ["restart preserves team data and uniqueness"]})
                print(engine + " " + scenario + ": passed", flush=True)
            except Exception as error:
                results.append({"engine": engine, "scenario": scenario, "success": False, "error": str(error)})
                print(engine + " " + scenario + ": " + str(error), flush=True)
            finally:
                command(compose + ["logs", "--no-color", "app"], env, case, "app-startup-logs")
                if not args.keep:
                    require(project.startswith("tgtest-"), "cleanup project boundary")
                    command(compose + ["down", "--volumes", "--remove-orphans"], env, case, "cleanup")
                else:
                    print("Retained isolated project " + project, flush=True)
            (evidence / "results.json").write_text(json.dumps({"application_image": args.image, "application_tag": runtime_image, "mysql_image": MYSQL_IMAGE, "old_image": OLD_IMAGE, "results": results}, indent=2), encoding="utf-8")
    print("Evidence: " + str(evidence))
    if not args.keep:
        tags = json.loads(command(["docker", "image", "inspect", runtime_image, "--format", "{{json .RepoTags}}"], env, evidence, "application-tags") or "[]")
        if any(tag != runtime_image for tag in tags):
            command(["docker", "image", "rm", "--no-prune", runtime_image], env, evidence, "unpin-application-image")
        else:
            print("Retained last application image tag: " + runtime_image)
    require(all(x["success"] for x in results), "database acceptance incomplete")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", action="store_true", required=True)
    parser.add_argument("--engine", choices=["all", "sqlite", "mysql", "postgres"], default="all")
    parser.add_argument("--scenario", choices=["all", "fresh", "upgrade"], default="all")
    parser.add_argument("--image", default="new-api-team-gateway:local")
    parser.add_argument("--port", type=int, default=18330)
    parser.add_argument("--skip-model-tests", action="store_true")
    parser.add_argument("--keep", action="store_true")
    matrix(parser.parse_args())
