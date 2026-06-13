const WebSocket = require('ws');
const http = require('http');
const https = require('https'); // ✅ Đã thêm hỗ trợ HTTPS

class Bot68GB {
    constructor(sharedConfig) {
        this.config = sharedConfig;
        this.ws = null;
        this.running = false;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;

        // Lưu dữ liệu kết quả
        this.txhu = { last_result: null, history: [] };
        this.md5 = { last_result: null, history: [] };

        // Thống kê trạng thái
        this.stats = {
            connected_at: null,
            packets_sent: 0,
            packets_received: 0,
            errors: 0
        };
    }

    // Kiểm tra kết nối còn sống không
    isAlive() {
        return this.ws && this.ws.readyState === WebSocket.OPEN && this.running;
    }

    // Khởi động bot
    async run(landingUrl) {
        if (this.running) return;
        this.running = true;

        try {
            // Tải trang đích để lấy cookie / thông tin cần thiết
            await this.preConnect(landingUrl);

            // Kết nối WebSocket
            this.connectWS();

        } catch (err) {
            console.error("❌ Lỗi khởi động bot:", err.message);
            this.scheduleReconnect();
        }
    }

    // Tải trang trước khi kết nối
    async preConnect(landingUrl) {
        return new Promise((resolve, reject) => {
            // ✅ Tự động chọn http hoặc https
            const client = landingUrl.startsWith('https') ? https : http;

            const req = client.get(landingUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                }
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400) {
                    // Xử lý chuyển hướng
                    return this.preConnect(res.headers.location).then(resolve).catch(reject);
                }

                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    console.log("✅ Đã tải trang đích thành công");
                    resolve(data);
                });
            });

            req.on('error', (err) => {
                console.error("❌ Lỗi tải trang:", err.message);
                reject(err);
            });

            req.setTimeout(15000, () => {
                req.destroy(new Error("Timeout tải trang"));
            });
        });
    }

    // Kết nối WebSocket
    connectWS() {
        if (this.ws) {
            try { this.ws.terminate(); } catch (e) {}
        }

        console.log("🔌 Đang kết nối đến:", this.config.WS_URL);

        this.ws = new WebSocket(this.config.WS_URL, {
            headers: {
                'Origin': 'https://68gbvn88.bar',
                'Referer': 'https://68gbvn88.bar/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
                'Sec-WebSocket-Version': '13'
            }
        });

        this.ws.on('open', () => this.onWSOpen());
        this.ws.on('message', (data) => this.onWSMessage(data));
        this.ws.on('close', (code, reason) => this.onWSClose(code, reason));
        this.ws.on('error', (err) => this.onWSError(err));
    }

    // Khi kết nối thành công
    onWSOpen() {
        console.log("✅ Kết nối WebSocket thành công!");
        this.stats.connected_at = new Date();

        // Gửi gói bắt tay
        this.sendPacket(this.config.PKT_HANDSHAKE);

        // Gửi xác nhận bắt tay sau 800ms
        setTimeout(() => {
            this.sendPacket(this.config.PKT_HANDSHAKE_ACK);

            // Gửi Token xác thực nếu có
            if (this.config.PKT_AUTH && this.config.PKT_AUTH.length > 0) {
                this.sendPacket(this.config.PKT_AUTH);
                console.log("🔑 Đã gửi Token xác thực thành công");
            }

            // Bắt đầu gửi heartbeat giữ kết nối
            this.startHeartbeat();

        }, 800);
    }

    // Khi nhận dữ liệu từ server
    onWSMessage(buffer) {
        this.stats.packets_received++;

        try {
            if (buffer.length < 4) return;

            // Đọc cấu trúc gói tin: 2 byte lệnh + 2 byte độ dài + dữ liệu
            const cmd = buffer.readUInt16BE(0);
            const len = buffer.readUInt16BE(2);
            const payload = buffer.slice(4);

            // Xử lý theo loại gói tin
            switch (cmd) {
                case 0x02: // ACK - Xác nhận
                    console.log("✅ Nhận xác nhận từ server");
                    break;

                case 0x03: // Heartbeat phản hồi
                    // console.log("💓 Heartbeat OK");
                    break;

                case 0x64: // Dữ liệu kết quả Tài Xỉu
                case 0x65: // Dữ liệu MD5
                    this.parseResult(payload);
                    break;

                default:
                    // Nếu là dữ liệu JSON, cố gắng phân tích
                    if (payload.length > 0) {
                        this.parseResult(payload);
                    }
            }

        } catch (e) {
            console.error("❌ Lỗi xử lý gói tin:", e.message);
            this.stats.errors++;
        }
    }

    // Phân tích kết quả Tài Xỉu
    parseResult(data) {
        try {
            // Chuyển Buffer -> Chuỗi
            const str = data.toString('utf8').trim();
            if (!str) return;

            // Thử parse JSON
            let json;
            try {
                json = JSON.parse(str);
            } catch {
                // Nếu không phải JSON, bỏ qua
                return;
            }

            // === XỬ LÝ TÀI XỈU HŨ ===
            if (json.type === "txhu" || json.game === "txhu") {
                const resultData = {
                    "Phiên trước": json.phase || json.id || "000000",
                    "kết quả": json.result === 1 || json.res === "TÀI" ? "TÀI" : "XỈU",
                    "xúc xắc 1": json.dice ? json.dice[0] : json.d1 || 0,
                    "xúc xắc 2": json.dice ? json.dice[1] : json.d2 || 0,
                    "xúc xắc 3": json.dice ? json.dice[2] : json.d3 || 0,
                    "tổng": json.total || 0,
                    "time": new Date().toISOString()
                };
                this.txhu.last_result = resultData;
                this.txhu.history.push(resultData);
                if (this.txhu.history.length > 200) this.txhu.history.shift(); // Giữ 200 bản ghi
                console.log("🎲 TÀI XỈU HŨ:", resultData['kết quả'], "| Phiên:", resultData['Phiên trước']);
            }

            // === XỬ LÝ TÀI XỈU MD5 ===
            if (json.type === "txmd5" || json.game === "txmd5") {
                const resultData = {
                    "Phiên trước": json.phase || json.id || "00000",
                    "kết quả": json.result === 1 || json.res === "TÀI" ? "TÀI" : "XỈU",
                    "xúc xắc 1": json.dice ? json.dice[0] : json.d1 || 0,
                    "xúc xắc 2": json.dice ? json.dice[1] : json.d2 || 0,
                    "xúc xắc 3": json.dice ? json.dice[2] : json.d3 || 0,
                    "tổng": json.total || 0,
                    "hash": json.hash || json.md5 || "",
                    "time": new Date().toISOString()
                };
                this.md5.last_result = resultData;
                this.md5.history.push(resultData);
                if (this.md5.history.length > 200) this.md5.history.shift();
                console.log("🔐 TÀI XỈU MD5:", resultData['kết quả'], "| Phiên:", resultData['Phiên trước']);
            }

        } catch (e) {
            // Bỏ qua lỗi nếu dữ liệu không hợp lệ
        }
    }

    // Khi kết nối đóng
    onWSClose(code, reason) {
        console.log(`🔌 Kết nối đóng: Mã ${code} | Lý do: ${reason || 'không rõ'}`);
        this.stopHeartbeat();
        this.scheduleReconnect();
    }

    // Khi có lỗi WebSocket
    onWSError(err) {
        console.error("❌ Lỗi WebSocket:", err.message);
        this.stats.errors++;
    }

    // Gửi gói tin
    sendPacket(buffer) {
        if (!this.isAlive()) return false;
        try {
            this.ws.send(buffer);
            this.stats.packets_sent++;
            return true;
        } catch (e) {
            console.error("❌ Lỗi gửi gói tin:", e.message);
            return false;
        }
    }

    // Bắt đầu gửi heartbeat giữ kết nối
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.isAlive()) {
                this.sendPacket(this.config.PKT_HEARTBEAT);
            }
        }, 15000); // Gửi mỗi 15 giây
    }

    // Dừng heartbeat
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    // Lên lịch kết nối lại
    scheduleReconnect() {
        this.running = false;
        if (this.reconnectTimer) return;

        console.log("🔄 Đang lên lịch kết nối lại sau 5 giây...");
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.run("https://68gbvn88.bar");
        }, 5000);
    }
}

module.exports = Bot68GB;
            
