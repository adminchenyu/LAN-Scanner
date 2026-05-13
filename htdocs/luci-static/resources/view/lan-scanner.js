'use strict';
'require view';
'require ui';
'require fs';

var state = {
	jobId: null,
	timer: null,
	filter: 'all',
	cidr: '192.168.0.0/24',
	data: {
		total: 0,
		scanned: 0,
		online: 0,
		unresponsive: 0,
		known_offline: 0,
		duration: 0,
		running: false,
		results: []
	}
};

function parseJson(stdout) {
	try {
		return JSON.parse(stdout || '{}');
	} catch (e) {
		return { ok: false, error: _('后端返回了无效 JSON。') };
	}
}

function callScanner(args) {
	return fs.exec('/usr/libexec/lan-scanner', args || []).then(function(res) {
		return {
			code: res && res.code,
			stdout: res && res.stdout ? res.stdout.trim() : '',
			stderr: res && res.stderr ? res.stderr.trim() : ''
		};
	});
}

function statusLabel(status) {
	if (status === 'online')
		return _('在线');
	if (status === 'known_offline')
		return _('离线');
	if (status === 'stopped')
		return _('已停止');
	return _('未响应');
}

function statusClass(status) {
	return 'lan-scanner-status lan-scanner-status-' + (status || 'unresponsive');
}

function validateCidr(cidr) {
	var m = String(cidr || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);

	if (!m)
		return false;

	for (var i = 1; i <= 4; i++) {
		var octet = Number(m[i]);
		if (!Number.isInteger(octet) || octet < 0 || octet > 255)
			return false;
	}

	var prefix = Number(m[5]);
	return Number.isInteger(prefix) && prefix >= 8 && prefix <= 30;
}

function cidrPrefix(cidr) {
	var m = String(cidr || '').match(/\/(\d{1,2})$/);
	return m ? Number(m[1]) : null;
}

function formatDuration(seconds) {
	seconds = Number(seconds || 0);
	if (seconds < 60)
		return seconds + 's';
	return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}

function headerStateText() {
	if (state.data.state === 'queued')
		return _('准备中');
	if (state.data.running)
		return _('扫描中');
	if (state.data.state === 'stopped')
		return _('已停止');
	if (state.data.state === 'done')
		return _('已完成');
	return _('就绪');
}

function progressPercent() {
	var total = Number(state.data.total || 0);
	var scanned = Number(state.data.scanned || 0);
	return total ? Math.min(100, Math.round(scanned * 100 / total)) : 0;
}

function visibleRows() {
	var rows = state.data.results || [];
	if (state.filter === 'all')
		return rows;
	return rows.filter(function(row) {
		return row.status === state.filter;
	});
}

function downloadFile(name, mime, content) {
	var blob = new Blob([ content ], { type: mime });
	var url = URL.createObjectURL(blob);
	var a = document.createElement('a');

	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

function utf8Bytes(str) {
	var bin = unescape(encodeURIComponent(String(str == null ? '' : str)));
	var bytes = new Uint8Array(bin.length);

	for (var i = 0; i < bin.length; i++)
		bytes[i] = bin.charCodeAt(i);

	return bytes;
}

var crcTable = null;

function crc32(bytes) {
	if (!crcTable) {
		crcTable = [];
		for (var n = 0; n < 256; n++) {
			var c = n;
			for (var k = 0; k < 8; k++)
				c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
			crcTable[n] = c >>> 0;
		}
	}

	var crc = 0xffffffff;
	for (var i = 0; i < bytes.length; i++)
		crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);

	return (crc ^ 0xffffffff) >>> 0;
}

function le16(out, value) {
	out.push(value & 0xff, (value >>> 8) & 0xff);
}

function le32(out, value) {
	out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concatBytes(parts) {
	var len = 0;
	for (var i = 0; i < parts.length; i++)
		len += parts[i].length;

	var out = new Uint8Array(len);
	var off = 0;
	for (var j = 0; j < parts.length; j++) {
		out.set(parts[j], off);
		off += parts[j].length;
	}

	return out;
}

function makeZip(files) {
	var localParts = [];
	var centralParts = [];
	var offset = 0;

	files.forEach(function(file) {
		var name = utf8Bytes(file.name);
		var data = utf8Bytes(file.content);
		var crc = crc32(data);
		var local = [];

		le32(local, 0x04034b50);
		le16(local, 20);
		le16(local, 2048);
		le16(local, 0);
		le16(local, 0);
		le16(local, 0);
		le32(local, crc);
		le32(local, data.length);
		le32(local, data.length);
		le16(local, name.length);
		le16(local, 0);

		var localBytes = concatBytes([ new Uint8Array(local), name, data ]);
		localParts.push(localBytes);

		var central = [];
		le32(central, 0x02014b50);
		le16(central, 20);
		le16(central, 20);
		le16(central, 2048);
		le16(central, 0);
		le16(central, 0);
		le16(central, 0);
		le32(central, crc);
		le32(central, data.length);
		le32(central, data.length);
		le16(central, name.length);
		le16(central, 0);
		le16(central, 0);
		le16(central, 0);
		le16(central, 0);
		le32(central, 0);
		le32(central, offset);
		centralParts.push(concatBytes([ new Uint8Array(central), name ]));
		offset += localBytes.length;
	});

	var centralStart = offset;
	var centralBytes = concatBytes(centralParts);
	var end = [];

	le32(end, 0x06054b50);
	le16(end, 0);
	le16(end, 0);
	le16(end, files.length);
	le16(end, files.length);
	le32(end, centralBytes.length);
	le32(end, centralStart);
	le16(end, 0);

	return concatBytes(localParts.concat([ centralBytes, new Uint8Array(end) ]));
}

function xmlEscape(value) {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function cellRef(col, row) {
	var name = '';
	col++;
	while (col > 0) {
		var mod = (col - 1) % 26;
		name = String.fromCharCode(65 + mod) + name;
		col = Math.floor((col - mod) / 26);
	}
	return name + row;
}

function sheetXml(rows) {
	var cols = [
		'<col min="1" max="1" width="18" customWidth="1"/>',
		'<col min="2" max="2" width="16" customWidth="1"/>',
		'<col min="3" max="3" width="16" customWidth="1"/>',
		'<col min="4" max="4" width="24" customWidth="1"/>',
		'<col min="5" max="5" width="24" customWidth="1"/>',
		'<col min="6" max="6" width="60" customWidth="1"/>'
	].join('');
	var body = rows.map(function(row, r) {
		var cells = row.map(function(value, c) {
			return '<c r="' + cellRef(c, r + 1) + '" t="inlineStr"><is><t>' + xmlEscape(value) + '</t></is></c>';
		}).join('');
		return '<row r="' + (r + 1) + '">' + cells + '</row>';
	}).join('');

	return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
		'<cols>' + cols + '</cols><sheetData>' + body + '</sheetData></worksheet>';
}

function exportXlsx() {
	var rows = [[ 'IP 地址', '状态', '响应时间', 'MAC 地址', '最后扫描时间', '备注说明' ]];

	visibleRows().forEach(function(row) {
		rows.push([
			row.ip,
			statusLabel(row.status),
			row.latency ? row.latency + ' ms' : '',
			row.mac,
			row.last_scan,
			row.note
		]);
	});

	var files = [
		{ name: '[Content_Types].xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
		{ name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
		{ name: 'xl/workbook.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="lan-scanner" sheetId="1" r:id="rId1"/></sheets></workbook>' },
		{ name: 'xl/_rels/workbook.xml.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
		{ name: 'xl/worksheets/sheet1.xml', content: sheetXml(rows) }
	];

	downloadFile('lan-scanner.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', makeZip(files));
}

function statCard(label, value, tone) {
	return E('div', { 'class': 'lan-scanner-card ' + (tone || '') }, [
		E('div', { 'class': 'lan-scanner-card-label' }, label),
		E('div', { 'class': 'lan-scanner-card-value' }, String(value == null ? '-' : value))
	]);
}

function renderCards() {
	var d = state.data;

	return E('div', { 'class': 'lan-scanner-cards' }, [
		statCard(_('在线数量'), d.online || 0, 'online'),
		statCard(_('未响应数量'), d.unresponsive || 0, 'unresponsive'),
		statCard(_('离线数量'), d.known_offline || 0, 'known-offline'),
		statCard(_('总扫描 IP 数量'), d.total || 0),
		statCard(_('扫描耗时'), formatDuration(d.duration || 0))
	]);
}

function renderProgress() {
	var pct = progressPercent();

	return E('div', { 'class': 'lan-scanner-progress-wrap' }, [
		E('div', { 'class': 'lan-scanner-progress-head' }, [
			E('span', {}, _('扫描进度')),
			E('strong', {}, (state.data.scanned || 0) + '/' + (state.data.total || 0))
		]),
		E('div', { 'class': 'lan-scanner-progress' }, [
			E('div', { 'class': 'lan-scanner-progress-bar', 'style': 'width:' + pct + '%' })
		])
	]);
}

function renderFilters(viewRoot) {
	var filters = [
		[ 'all', _('全部') ],
		[ 'online', _('在线') ],
		[ 'unresponsive', _('未响应') ],
		[ 'known_offline', _('离线') ]
	];

	return E('div', { 'class': 'lan-scanner-filterbar' }, filters.map(function(item) {
		return E('button', {
			'class': 'btn ' + (state.filter === item[0] ? 'cbi-button-action' : ''),
			'click': function() {
				state.filter = item[0];
				update(viewRoot);
			}
		}, item[1]);
	}));
}

function renderTable() {
	var rows = visibleRows();
	var body = rows.length ? rows.map(function(row) {
		return E('tr', {}, [
			E('td', { 'class': 'mono' }, row.ip || '-'),
			E('td', {}, E('span', { 'class': statusClass(row.status) }, statusLabel(row.status))),
			E('td', {}, row.latency ? row.latency + ' ms' : '-'),
			E('td', { 'class': 'mono' }, row.mac || '-'),
			E('td', {}, row.last_scan || '-'),
			E('td', { 'class': 'lan-scanner-note' }, row.note || '-')
		]);
	}) : [
		E('tr', {}, [
			E('td', { 'colspan': 6, 'class': 'lan-scanner-empty' }, _('暂无扫描结果'))
		])
	];

	return E('div', { 'class': 'lan-scanner-table-wrap' }, [
		E('table', { 'class': 'table lan-scanner-table' }, [
			E('colgroup', {}, [
				E('col', { 'class': 'ip' }),
				E('col', { 'class': 'status' }),
				E('col', { 'class': 'latency' }),
				E('col', { 'class': 'mac' }),
				E('col', { 'class': 'last-scan' }),
				E('col', { 'class': 'note' })
			]),
			E('thead', {}, E('tr', {}, [
				E('th', {}, _('IP 地址')),
				E('th', {}, _('状态')),
				E('th', {}, _('响应时间')),
				E('th', {}, _('MAC 地址')),
				E('th', {}, _('最后扫描时间')),
				E('th', {}, _('备注说明'))
			])),
			E('tbody', {}, body)
		])
	]);
}

function renderContent(viewRoot) {
	var cidrInput = E('input', {
		'id': 'lan-scanner-cidr',
		'class': 'cbi-input-text',
		'type': 'text',
		'value': state.cidr,
		'placeholder': '192.168.0.0/24',
		'disabled': state.data.running ? 'disabled' : null
	});

	return E('div', { 'class': 'lan-scanner' }, [
		E('style', {}, [
			'.lan-scanner{max-width:1280px;margin:0 auto}.lan-scanner-hero{width:100%;margin:0 0 18px;box-sizing:border-box}.lan-scanner-title{width:100%;box-sizing:border-box}.lan-scanner-title h2{margin:0;font-size:26px}.lan-scanner-toolbar-state{margin-left:auto;color:#344054;font-weight:600;white-space:nowrap}.lan-scanner-command{min-width:88px;height:38px;display:inline-flex;align-items:center;justify-content:center;padding:0 14px;box-sizing:border-box}.lan-scanner-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:14px 0}.lan-scanner-card{border:1px solid #dfe5ec;background:#fff;border-radius:8px;padding:14px 16px;box-shadow:0 1px 2px rgba(0,0,0,.04)}.lan-scanner-card-label{color:#667085;font-size:12px}.lan-scanner-card-value{font-size:24px;font-weight:700;margin-top:6px}.lan-scanner-card.online .lan-scanner-card-value{color:#137a3a}.lan-scanner-card.unresponsive .lan-scanner-card-value{color:#9a3412}.lan-scanner-card.known-offline .lan-scanner-card-value{color:#475467}.lan-scanner-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;border:1px solid #dfe5ec;border-radius:8px;background:#fff;padding:12px;margin-bottom:12px}.lan-scanner-toolbar input{min-width:260px;max-width:360px}.lan-scanner-progress-wrap{border:1px solid #dfe5ec;border-radius:8px;background:#fff;padding:12px;margin-bottom:12px}.lan-scanner-progress-head{display:flex;justify-content:space-between;margin-bottom:8px;color:#344054}.lan-scanner-progress{height:10px;border-radius:999px;background:#eef2f6;overflow:hidden}.lan-scanner-progress-bar{height:100%;background:#2563eb;transition:width .25s ease}.lan-scanner-filterbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.lan-scanner-table-wrap{border:1px solid #dfe5ec;border-radius:8px;background:#fff;overflow:auto}.lan-scanner-table{margin:0;min-width:1100px;table-layout:fixed}.lan-scanner-table col.ip{width:150px}.lan-scanner-table col.status{width:150px}.lan-scanner-table col.latency{width:150px}.lan-scanner-table col.mac{width:200px}.lan-scanner-table col.last-scan{width:200px}.lan-scanner-table col.note{width:auto}.lan-scanner-table th{white-space:nowrap;background:#f8fafc;text-align:left}.lan-scanner-table td{vertical-align:middle;overflow:hidden;text-overflow:ellipsis}.lan-scanner-table td:nth-child(1),.lan-scanner-table td:nth-child(3),.lan-scanner-table td:nth-child(4),.lan-scanner-table td:nth-child(5){white-space:nowrap}.lan-scanner-status{display:inline-flex;align-items:center;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:700}.lan-scanner-status-online{background:#dcfce7;color:#166534}.lan-scanner-status-unresponsive{background:#ffedd5;color:#9a3412}.lan-scanner-status-known_offline{background:#e5e7eb;color:#374151}.lan-scanner-note{color:#5f6673;white-space:normal;line-height:1.45}.lan-scanner-empty{text-align:center;color:#667085;padding:28px!important}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}@media(max-width:700px){.lan-scanner-toolbar input{min-width:100%;max-width:none}.lan-scanner-toolbar-state{margin-left:0;width:100%;text-align:right}}'
		].join('')),
		E('div', { 'class': 'lan-scanner-hero' }, [
			E('div', { 'class': 'lan-scanner-title' }, [
				E('h2', {}, _('局域网设备扫描'))
			])
		]),
		renderCards(),
		E('div', { 'class': 'lan-scanner-toolbar' }, [
			cidrInput,
			E('button', {
				'class': 'btn cbi-button-action lan-scanner-command',
				'disabled': state.data.running ? 'disabled' : null,
				'click': function() {
					startScan(viewRoot, cidrInput.value);
				}
			}, state.data.running ? (state.data.state === 'queued' ? _('准备中...') : _('扫描中...')) : _('开始扫描')),
			E('button', {
				'class': 'btn cbi-button-negative lan-scanner-command',
				'disabled': state.data.running ? null : 'disabled',
				'click': function() {
					stopScan(viewRoot);
				}
			}, _('停止扫描')),
			E('button', { 'class': 'btn lan-scanner-command', 'click': exportXlsx }, _('导出结果')),
			E('div', { 'class': 'lan-scanner-toolbar-state' }, headerStateText())
		]),
		renderProgress(),
		renderFilters(viewRoot),
		renderTable()
	]);
}

function update(viewRoot) {
	viewRoot.innerHTML = '';
	viewRoot.appendChild(renderContent(viewRoot));
}

function schedulePoll(viewRoot) {
	if (state.timer)
		window.clearTimeout(state.timer);

	if (!state.jobId || !state.data.running)
		return;

	state.timer = window.setTimeout(function() {
		pollStatus(viewRoot);
	}, 1000);
}

function stopScan(viewRoot) {
	if (!state.jobId || !state.data.running)
		return;

	callScanner([ 'stop', state.jobId ]).then(function(res) {
		var data = parseJson(res.stdout);

		if (!data.ok) {
			ui.addNotification(null, E('p', {}, data.error || res.stderr || _('停止扫描失败。')), 'danger');
			return;
		}

		pollStatus(viewRoot);
	}).catch(function(err) {
		ui.addNotification(null, E('p', {}, (err && err.message) ? err.message : _('停止扫描失败。')), 'danger');
	});
}

function confirmLargeScan() {
	if (!ui.showModal)
		return Promise.resolve(window.confirm(_('当前网段范围较大，包含大量 IP。扫描可能耗时很久，并占用路由器 CPU、内存和 /tmp 空间，期间 LuCI 页面响应可能变慢。建议优先使用 /24、/25、/26 等较小网段。确定继续扫描吗？')));

	return new Promise(function(resolve) {
		var finish = function(value) {
			ui.hideModal();
			resolve(value);
		};

		ui.showModal(_('确认扫描大网段'), [
			E('p', {}, _('当前网段范围较大，包含大量 IP。扫描可能耗时很久，并占用路由器 CPU、内存和 /tmp 空间，期间 LuCI 页面响应可能变慢。')),
			E('p', {}, _('建议优先使用 /24、/25、/26 等较小网段。确定继续扫描吗？')),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': function() {
						finish(false);
					}
				}, _('取消')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': function() {
						finish(true);
					}
				}, _('继续扫描'))
			])
		]);
	});
}

function beginScan(viewRoot, cidr) {
	state.cidr = cidr;
	state.data = {
		state: 'queued',
		cidr: cidr,
		total: 0,
		scanned: 0,
		online: 0,
		unresponsive: 0,
		known_offline: 0,
		duration: 0,
		running: true,
		results: []
	};
	update(viewRoot);

	callScanner([ 'start', cidr ]).then(function(res) {
		var data = parseJson(res.stdout);

		if (!data.ok) {
			state.data.running = false;
			update(viewRoot);
			ui.addNotification(null, E('p', {}, data.error || res.stderr || _('启动扫描失败。')), 'danger');
			return;
		}

		state.jobId = data.job_id;
		state.data.total = data.total || 0;
		state.data.running = true;
		schedulePoll(viewRoot);
	}).catch(function(err) {
		state.data.running = false;
		update(viewRoot);
		ui.addNotification(null, E('p', {}, (err && err.message) ? err.message : _('启动扫描失败。')), 'danger');
	});
}

function pollStatus(viewRoot) {
	if (!state.jobId)
		return;

	callScanner([ 'status', state.jobId ]).then(function(res) {
		var data = parseJson(res.stdout);

		if (!data.ok) {
			ui.addNotification(null, E('p', {}, data.error || _('读取扫描状态失败。')), 'danger');
			state.data.running = false;
			update(viewRoot);
			return;
		}

		state.data = data;
		if (data.state === 'queued' && data.duration > 8) {
			state.data.running = false;
			update(viewRoot);
			ui.addNotification(null, E('p', {}, _('扫描任务未能启动。请在 SSH 中执行 /usr/libexec/lan-scanner start 192.168.0.0/24 查看后端错误。')), 'danger');
			return;
		}
		update(viewRoot);
		schedulePoll(viewRoot);
	}).catch(function(err) {
		ui.addNotification(null, E('p', {}, (err && err.message) ? err.message : _('读取扫描状态失败。')), 'danger');
		state.data.running = false;
		update(viewRoot);
	});
}

function startScan(viewRoot, cidr) {
	cidr = String(cidr || '').trim();

	if (!validateCidr(cidr)) {
		ui.addNotification(null, E('p', {}, _('CIDR 格式无效。请输入 192.168.0.0/24 这类 IPv4 网段，前缀范围为 /8 到 /30。')), 'danger');
		return;
	}

	var prefix = cidrPrefix(cidr);
	if (prefix >= 8 && prefix <= 20) {
		confirmLargeScan().then(function(ok) {
			if (ok)
				beginScan(viewRoot, cidr);
		});
		return;
	}

	beginScan(viewRoot, cidr);
}

return view.extend({
	load: function() {
		return Promise.all([
			callScanner([ 'cleanup' ]).catch(function() {}),
			callScanner([ 'default-cidr' ]).then(function(res) {
				var data = parseJson(res.stdout);
				if (data.ok && data.cidr)
					state.cidr = data.cidr;
			}).catch(function() {})
		]);
	},

	render: function() {
		var root = E('div');
		update(root);
		return root;
	},

	handleReset: null,
	handleSaveApply: null,
	handleSave: null
});



