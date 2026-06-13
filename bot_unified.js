const WebSocket = require('ws');
const http = require('http');

class Bot68GB {
    constructor(sharedConfig) {
        this.config = sharedConfig;
        this.ws = null;
        this.running = false;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;

        // Lưu dữ liệu
        this.txhu = { last_result: null, history: [] };
        this.md5 = { last_result: null, history: [] };

        this.stats = {
            connected_at: null,
            packets_sent: 0,
            packets_received: 0,
            errors: 0
        };
    }

    isAlive() {
        return this.ws && this.ws.readyState === WebSocket.OPEN && this.running;
    }

    async run(landingUrl) {
        if (this.running) return;
        this.running = true;

        try {
            // Lấy thông tin ban đầu
            await this.preConnect(landingUrl);

            // Kết nối WebSocket
            this.connectWS();

        } catch (err) {
            console.error("❌ Lỗi khởi động bot:", err);
            this.scheduleReconnect();
        }
    }

    async preConnect(landingUrl) {
        return new Promise((resolve, reject) => {
            http.get(landingUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
                }
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    console.log("✅ Đã tải trang đích");
                    resolve(data);
                });
            }).on('error', reject);
        });
    }

    connectWS() {
        if (this.ws) {
            try { this.ws.terminate(); } catch (e) {}
        }

        console.log("🔌 Đang kết nối đến:", this.config.WS_URL);

        this.ws = new WebSocket(this.config.WS_URL, {
            headers: {
                'Origin': 'https://68gbvn88.bar',
                'Referer': 'https://68gbvn88.bar/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            }
        });

        this.ws.on('open', () => this.onWSOpen());
        this.ws.on('message', (data) => this.onWSMessage(data));
        this.ws.on('close', (code, reason) => this.onWSClose(code, reason));
        this.ws.on('error', (err) => this.onWSError(err));
    }

    onWSOpen() {
        console.log("✅ Kết nối WebSocket thành công!");
        this.stats.connected_at = new Date();

        // Gửi gói bắt tay
        this.sendPacket(this.config.PKT_HANDSHAKE);

        // Gửi xác nhận bắt tay
        setTimeout(() => {
            this.sendPacket(this.config.PKT_HANDSHAKE_ACK);

            // Gửi Token xác thực
            if (this.config.PKT_AUTH && this.config.PKT_AUTH.length > 0) {
                this.sendPacket(this.config.PKT_AUTH);
                console.log("🔑 Đã gửi Token xác thực");
            }

            // Bắt đầu gửi heartbeat
            this.startHeartbeat();

        }, 800);
    }

    onWSMessage(buffer) {
        this.stats.packets_received++;

        try {
            // Xử lý dữ liệu nhận được
            if (buffer.length < 4) return;

            const cmd = buffer.readUInt16BE(0);
            const len = buffer.readUInt16BE(2);
            const payload = buffer.slice(4);

            // Xử lý theo loại gói tin
            switch (cmd) {
                case 0x02: // ACK
                    console.log("✅ Nhận xác nhận kết nối");
                    break;

                case 0x03: // Heartbeat phản hồi
                    // console.log("💓 Heartbeat OK");
                    break;

                case 0x64: // Dữ liệu kết quả Tài Xỉu
                    this.parseResult(payload);
                    break;

                default:
                    if (payload.length > 0) {
                        this.parseResult(payload);
                    }
            }

        } catch (e) {
            console.error("❌ Lỗi xử lý gói tin:", e.message);
            this.stats.errors++;
        }
    }

    parseResult(data) {
        try {
            // Chuyển dữ liệu Buffer -> Chuỗi & phân tích kết quả
            const str = data.toString('utf8').trim();
            
            // Giả định dữ liệu có dạng JSON hoặc chuỗi kết quả
            let json;
            try { json = JSON.parse(str); } catch { return; }

            if (json && json.type === "txhu") {
                const resultData = {
                    "Phiên trước": json.phase || "000000",
                    "kết quả": json.result === 1 ? "TÀI" : "XỈU",
                    "xúc xắc 1": json.dice[0],
                    "xúc xắc 2": json.dice[1],
                    "xúc xắc 3": json.dice[2],
                    "tổng": json.total,
                    "time": new Date().toISOString()
                };
                this.txhu.last_result = resultData;
                this.txhu.history.push(resultData);
                if (this.txhu.history.length > 100) this.txhu.history.shift();
            }

            if (json && json.type === "txmd5") {
                const resultData = {
                    "Phiên trước": json.phase || "00000",
                    "kết quả": json.result === 1 ? "TÀI" : "XỈU",
                    "xúc xắc 1": json.dice[0],
                    "xúc xắc 2": json.dice[1],
                    "xúc xắc 3": json.dice[2],
                    "tổng": json.total,
                    "hash": json.hash || "",
                    "time": new Date().toISOString()
                };
                this.md5.last_result = resultData;
                this.md5.history.push(resultData);
                if (this.md5.history.length > 100) this.md5.history.shift();
            }

        } catch (e) {
            // Không log lỗi nếu chỉ là dữ liệu không hợp lệ
        }
    }

    onWSClose(code, reason) {
        console.log(`🔌 Kết nối đóng: Mã ${code} | Lý do: ${reason || 'không rõ'}`);
        this.stopHeartbeat();
        this.scheduleReconnect();
    }

    onWSError(err) {
        console.error("❌ Lỗi WebSocket:", err.message);
        this.stats.errors++;
    }

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

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.sendPacket(this.config.PKT_HEARTBEAT);
        }, 15000); // Gửi mỗi 15 giây
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

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
