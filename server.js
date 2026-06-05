const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');

// Khởi tạo Express App
const app = express();
app.use(cors());

// Cổng chạy ứng dụng (Render tự động cấp PORT qua process.env.PORT)
const PORT = process.env.PORT || 3000;

// Bộ lưu trữ trạng thái game đồng bộ
const DATA = {
  phien: null,
  md5: null,
  dice: [],
  tong: null,
  ketqua: null,
  duDoan: null, // Dự đoán phiên hiện tại: "TAI" hoặc "XIU"
  tiLeThanhCong: null // Phần trăm ngẫu nhiên từ 70% đến 90%
};

// ==========================================
// API ENDPOINTS
// ==========================================

// Endpoint lấy dữ liệu hiện tại
app.get('/68gb', (req, res) => {
  res.json(DATA);
});

// Endpoint thiết lập số phiên thủ công để đồng bộ hóa
app.get('/setup=:phien-yes', (req, res) => {
  try {
    const phienNum = parseInt(req.params.phien, 10);
    if (isNaN(phienNum)) {
      return res.json({ status: "ERROR", message: "Invalid session number" });
    }
    DATA.phien = phienNum;
    res.json({ status: "OK", phien: phienNum });
  } catch (err) {
    res.json({ status: "ERROR" });
  }
});

// Endpoint mặc định kiểm tra trạng thái hoạt động (Health check cho Render)
app.get('/', (req, res) => {
  res.send('MD5 Game Tracker Server is Running! Access /68gb for data.');
});

// Khởi chạy HTTP Server
app.listen(PORT, () => {
  console.log(`🚀 API Server đang chạy tại cổng: ${PORT}`);
});

// ==========================================
// WS CONFIG & CONSTANTS
// ==========================================

const WS_URL = "wss://ugaq8hxbh0nmjhi.cq.qnwxdhwica.com/";

const HANDSHAKE_B64 = "AQAAcnsic3lzIjp7InBsYXRmb3JtIjoianMtd2Vic29ja2V0IiwiY2xpZW50QnVpbGROdW1iZXIiOiIwLjAuMSIsImNsaWVudFZlcnNpb24iOiIwYTIxNDgxZDc0NmY5MmY4NDI4ZTFiNmRlZWI3NmZlYSJ9fQ==";
const HANDSHAKE_ACK = "AgAAAA==";
const LOGIN_AUTH = "BAAATQEBAAEIAhDIARpAMWE1Y2VmM2Q1YzZiNGFjOWJiMGU5ZTUzYWIxYjYzNGI5MDNkNjU4ZjA1NTk0NDUzYWExZTZmMTI0ZTBkOTFmZUIA";
const HEARTBEAT = "AwAAAA==";

// Biến đếm ID Gói tin tăng dần
let MSG_ID = 4;
let wsClient = null;
let heartbeatInterval = null;

// ==========================================
// TIỆN ÍCH TẠO GÓI TIN DỰA TRÊN POMELO PROTOCOL
// ==========================================

/**
 * Tạo gói tin động chuẩn Pomelo với Sequence ID tăng dần
 */
function sendPomeloReq(ws, route) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const msgId = MSG_ID++;
  const routeBuffer = Buffer.from(route, 'utf-8');
  const routeLen = routeBuffer.length;

  // Encode Varint cho msgId
  const msgIdBytes = [];
  let temp = msgId;
  while (true) {
    const b = temp & 0x7f;
    temp >>>= 7;
    if (temp > 0) {
      msgIdBytes.push(b | 0x80);
    } else {
      msgIdBytes.push(b);
      break;
    }
  }

  // Khởi tạo Payload: [type] + [msgIdBytes] + [routeLen] + [routeBuffer]
  const payload = Buffer.concat([
    Buffer.from([0x00]), // Type (Request)
    Buffer.from(msgIdBytes),
    Buffer.from([routeLen]),
    routeBuffer
  ]);

  const length = payload.length;

  // Header Pomelo: [package_type (0x04)] + [length (3 bytes)]
  const header = Buffer.from([
    0x04,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff
  ]);

  const packet = Buffer.concat([header, payload]);

  try {
    ws.send(packet);
  } catch (err) {
    console.error(`[ERROR_SEND_DYN] ${err.message}`);
  }
}

/**
 * Gửi dữ liệu Base64 đã giải mã sang nhị phân
 */
function b64Send(ws, base64Str) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const buffer = Buffer.from(base64Str, 'base64');
    ws.send(buffer);
  } catch (err) {
    // Bỏ qua lỗi gửi tin thông thường
  }
}

/**
 * Thuật toán dự đoán kết quả MD5 phiên mới
 * Dựa trên ký tự cuối cùng của mã MD5 hiện tại kết hợp yếu tố giả lập tỷ lệ 70-90%
 */
function generatePrediction(md5) {
  if (!md5) return;

  // Lấy ngẫu nhiên tỉ lệ từ 70% đến 90%
  const randomPercent = Math.floor(Math.random() * (90 - 70 + 1)) + 70;
  
  // Tạo tính toán giả định dựa trên mã MD5 để tăng tính nhất quán của thuật toán dự báo
  const lastChar = md5.slice(-1);
  const code = lastChar.charCodeAt(0);
  
  // Chẵn -> TÀI, Lẻ -> XỈU
  const prediction = (code % 2 === 0) ? "TAI" : "XIU";

  DATA.duDoan = prediction;
  DATA.tiLeThanhCong = `${randomPercent}%`;

  console.log(`🔮 Dự đoán phiên này: ${prediction} | Tỷ lệ thành công: ${randomPercent}%`);
}

// ==========================================
// QUẢN LÝ KẾT NỐI WEBSOCKET
// ==========================================

function startWsLoop() {
  console.log("🔌 Đang kết nối đến cổng WebSocket game...");
  wsClient = new WebSocket(WS_URL);

  wsClient.on('open', () => {
    MSG_ID = 4; // Reset bộ đếm ID gói tin
    console.log("✅ WS CONNECTED - Đang tiến hành handshake & đăng nhập...");

    // Handshake & Đăng nhập phòng chơi giống như Python
    b64Send(wsClient, HANDSHAKE_B64);
    
    setTimeout(() => {
      b64Send(wsClient, HANDSHAKE_ACK);
      b64Send(wsClient, LOGIN_AUTH);
    }, 1000);

    setTimeout(() => {
      sendPomeloReq(wsClient, "mnmdsb.mnmdsbhandler.entergameroom");
    }, 1500);

    setTimeout(() => {
      sendPomeloReq(wsClient, "mnmdsb.mnmdsbhandler.getgamescene");
    }, 2000);

    setTimeout(() => {
      sendPomeloReq(wsClient, "mnmdsb.mnmdsbhandler.reqpokerinfo");
    }, 2500);

    // Bắt đầu nhịp tim giữ kết nối (Heartbeat) định kỳ 10 giây
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      b64Send(wsClient, HEARTBEAT);
    }, 10000);

    console.log("✅ WS READY - Đã gửi toàn bộ gói tin mở phòng MD5!");
  });

  wsClient.on('message', (message) => {
    try {
      let text = "";
      if (Buffer.isBuffer(message)) {
        // GIẢI QUYẾT LỖI PYTHON VS JS: 
        // Loại bỏ hoàn toàn các ký tự điều khiển nhị phân không đọc được (non-printable) 
        // để biểu thức Regex hoạt động chính xác trên chuỗi sạch.
        text = message.toString('binary').replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, "");
      } else {
        text = String(message);
      }

      // ----------------------------------------
      // XỬ LÝ SỰ KIỆN KẾT THÚC VÁN (GAME END)
      // ----------------------------------------
      if (text.includes("mnmdsbgameend")) {
        const diceMatch = text.match(/\{(\d+)-(\d+)-(\d+)\}/);
        if (diceMatch) {
          const d1 = parseInt(diceMatch[1], 10);
          const d2 = parseInt(diceMatch[2], 10);
          const d3 = parseInt(diceMatch[3], 10);
          const tong = d1 + d2 + d3;
          const kq = tong >= 11 ? "TAI" : "XIU";

          DATA.dice = [d1, d2, d3];
          DATA.tong = tong;
          DATA.ketqua = kq;
          DATA.md5 = null;
          DATA.duDoan = null; // Reset dự đoán cũ
          DATA.tiLeThanhCong = null;

          if (DATA.phien !== null) {
            DATA.phien += 1;
          }

          console.log(`🎲 Kết quả: ${d1}-${d2}-${d3} | Tổng: ${tong} (${kq})`);
          console.log(`➡️ Đang chờ phiên mới: ${DATA.phien || "Đang chờ đồng bộ..."}`);

          // Chống AFK: Gửi yêu cầu phòng chơi sau khi kết thúc phiên để giữ kết nối
          setTimeout(() => {
            sendPomeloReq(wsClient, "mnmdsb.mnmdsbhandler.entergameroom");
            setTimeout(() => {
              sendPomeloReq(wsClient, "mnmdsb.mnmdsbhandler.reqpokerinfo");
            }, 500);
          }, 1000);
        }
      }

      // ----------------------------------------
      // XỬ LÝ SỰ KIỆN BẮT ĐẦU VÁN MỚI (GAME START)
      // ----------------------------------------
      if (text.includes("mnmdsbgamestart")) {
        const md5Match = text.match(/[a-f0-9]{32}/);
        if (md5Match) {
          const md5Value = md5Match[0];
          DATA.md5 = md5Value;
          const hienTai = DATA.phien !== null ? DATA.phien : "Đang chờ đồng bộ...";
          console.log(`🔥 Bắt đầu Phiên [${hienTai}] - MD5: ${md5Value}`);

          // Tạo dự đoán dựa trên MD5 phiên mới với tỉ lệ ngẫu nhiên 70-90%
          generatePrediction(md5Value);
        }
      }

    } catch (err) {
      console.error(`[ERROR_PARSE] ${err.message}`);
    }
  });

  wsClient.on('error', (err) => {
    // Bỏ qua log lỗi thừa để console gọn gàng
  });

  wsClient.on('close', () => {
    console.warn("⚠️ Mất kết nối đến Máy chủ. Đang tiến hành kết nối lại sau 3 giây...");
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    setTimeout(startWsLoop, 3000);
  });
}

// Bắt đầu vòng lặp quản lý kết nối
startWsLoop();
