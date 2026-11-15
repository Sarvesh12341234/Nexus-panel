#!/usr/bin/env python3
"""Run a disposable non-root panel and exercise its real HTTP file routes."""
import http.cookiejar
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

assert os.geteuid() == 0, 'Run this disposable test as root on Linux.'
repo = Path(__file__).resolve().parents[1]
account = pwd.getpwnam('nobody')
with tempfile.TemporaryDirectory(prefix='nexuspanel-smoke-', dir='/tmp') as temp:
    root = Path(temp)
    os.chmod(root, 0o755)
    panel = root / 'panel'
    panel.mkdir()
    for name in ['backend', 'frontend', 'ai', 'native', 'node_modules']:
        shutil.copytree(repo / name, panel / name, symlinks=True)
    for name in ['package.json', 'package-lock.json']:
        shutil.copy2(repo / name, panel / name)
    for directory in ['data', 'servers', 'software', 'backups', 'backupfolder', 'update/backups']:
        (panel / directory).mkdir(parents=True, exist_ok=True)
    varlib = root / 'varlib'
    varlib.mkdir()
    installer = (repo / 'installers/nexuspanel-normal-v1.0.0-linux-installer.sh').read_text()
    function = installer.split('repair_install_permissions() {', 1)[1].split('\n}\n', 1)[0]
    function = 'repair_install_permissions() {' + function + '\n}\n'
    function = function.replace('/var/lib/nexuspanel', str(varlib)).replace('/usr/local/bin/nexuspanel', str(root / 'cli'))
    script = 'set -e\ninfo(){ :; }\nwarn(){ echo "$*" >&2; }\ndie(){ echo "$*" >&2; exit 1; }\n' + function + '\nrepair_install_permissions\n'
    subprocess.run(['bash'], input=script, text=True, check=True,
                   env={**os.environ, 'INSTALL_DIR': str(panel), 'SERVICE_USER': 'nobody'})
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'PORT': str(port), 'NEXUSPANEL_DATA_ROOT': str(varlib),
           'NEXUSPANEL_DATA_DIR': str(panel / 'data'), 'NEXUSPANEL_OWNER_EMAIL': 'smoke@example.test',
           'NEXUSPANEL_OWNER_PASSWORD': 'Disposable-test-password-123!', 'HOME': str(root)}
    def drop_privileges():
        os.setgroups([])
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
    with (root / 'panel.log').open('w+') as log:
        process = subprocess.Popen(['node', str(panel / 'backend/index.js')], cwd=panel, env=env,
                                   stdout=log, stderr=subprocess.STDOUT, preexec_fn=drop_privileges)
        try:
            base = f'http://127.0.0.1:{port}'
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            def call(method, route, body=None):
                headers = {'X-NexusPanel-Request': '1'}
                data = None
                if body is not None:
                    data = json.dumps(body).encode()
                    headers['Content-Type'] = 'application/json'
                request = urllib.request.Request(base + route, data=data, headers=headers, method=method)
                start = time.monotonic()
                with opener.open(request, timeout=15) as response:
                    payload = json.load(response)
                return payload, round((time.monotonic() - start) * 1000)
            for _ in range(120):
                try:
                    call('GET', '/api/bootstrap')
                    break
                except (OSError, urllib.error.URLError):
                    if process.poll() is not None:
                        raise RuntimeError('Panel exited during startup')
                    time.sleep(.25)
            else:
                raise RuntimeError('Panel did not start')
            call('POST', '/api/login', {'email': env['NEXUSPANEL_OWNER_EMAIL'], 'password': env['NEXUSPANEL_OWNER_PASSWORD']})
            server, create_ms = call('POST', '/api/servers', {'name': 'Smoke Test', 'type': 'java'})
            prefix = '/api/servers/' + str(server['server']['id'])
            call('POST', prefix + '/files/mkdir', {'path': 'sample'})
            call('PUT', prefix + '/files', {'path': 'sample/example.txt', 'content': 'hello world'})
            bulk = panel / 'servers' / '1-smoke-test' / 'sample' / 'bulk'
            bulk.mkdir()
            os.chown(bulk, account.pw_uid, account.pw_gid)
            for i in range(1200):
                (bulk / f'entry-{i:04}.txt').write_text('test data')
            (bulk / 'too-large.txt').write_bytes(b'x' * (1024 * 1024 + 1))
            listing, list_ms = call('GET', prefix + '/files?path=sample')
            assert any(item['name'] == 'example.txt' for item in listing['entries'])
            results, search_ms = call('GET', prefix + '/files/search?q=example&mode=name')
            assert any(item['path'] == 'sample/example.txt' for item in results['results'])
            broad_results, broad_ms = call('GET', prefix + '/files/search?q=entry&mode=name')
            assert len(broad_results['results']) == 250 and broad_results['truncated']
            results, content_ms = call('GET', prefix + '/files/search?q=hello&mode=content')
            assert any(item['path'] == 'sample/example.txt' for item in results['results'])
            assert results['skippedFiles'] == 1 and results['truncated']
            bulk_listing, bulk_list_ms = call('GET', prefix + '/files?path=sample%2Fbulk')
            assert len(bulk_listing['entries']) == 1201
            _, console_ms = call('GET', prefix + '/console')
            start = time.monotonic()
            with opener.open(base + prefix + '/console/stream', timeout=15) as stream:
                assert stream.readline().decode().strip() == 'event: snapshot'
                snapshot = stream.readline().decode().strip()
                assert snapshot.startswith('data: ')
                assert 'lines' in json.loads(snapshot[6:])
            stream_ms = round((time.monotonic() - start) * 1000)
            _, delete_ms = call('POST', prefix + '/files/delete-batch', {'paths': ['sample']})
            print(json.dumps({'passed': True, 'milliseconds': {'createServer': create_ms, 'openFolder': list_ms,
                  'nameSearch': search_ms, 'broadNameSearch': broad_ms, 'contentSearch': content_ms, 'open1200Files': bulk_list_ms,
                  'console': console_ms, 'consoleStream': stream_ms, 'deleteFolder': delete_ms}}))
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            if process.returncode not in (0, -15):
                log.flush()
                log.seek(0)
                print(log.read()[-5000:])
