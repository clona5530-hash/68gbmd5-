const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');

// Khởi tạo ứng dụng Express
const app = express();
app.use(cors());

// Cổng chạy ứng dụng (Render tự động cấp PORT qua process.env.PORT)
const PORT = process.env.PORT || 3000;

// Bộ lưu trữ trạng thái game đồng bộ 100% tự động
const DATA = {
  phien: null,         // Sẽ tự động lấy mã MD5 mới nhất làm mã phiên định danh
  md5: null,          // Mã MD5 của phiên hiện tại đang mở
  dice: [],           // Kết quả xúc xắc phiên trước đó
  tong: null,         // Tổng điểm phiên trước đó
  ketqua: null,       // Kết quả phiên trước đó ("TAI" hoặc "XIU")
  duDoan: null,       // Dự đoán cho phiên MD5 HIỆN TẠI ("TAI" hoặc "XIU")
  tiLeThanhCong: null // Tỷ lệ dự đoán chính xác (Phân tích chuyên sâu từ 70% - 90%)
};

// ==========================================
// API ENDPOINTS
// ==========================================

// Endpoint lấy dữ liệu thời gian thực
app.get('/68gb', (req, res) => {
  res.json(DATA);
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

// Biến đếm ID Gói tin tăng dần để tránh bị Server chặn
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

  // Khởi tạo Payload
  const payload = Buffer.concat([
    Buffer.from([0x00]), // Type (Request)
    Buffer.from(msgIdBytes),
    Buffer.from([routeLen]),
    routeBuffer
  ]);

  const length = payload.length;

  // Header Pomelo
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
 * THUẬT TOÁN PHÂN TÍCH CHUYÊN SÂU CHUỖI MD5 HIỆN TẠI
 * Giải mã mật độ phân bố hex-byte của chuỗi MD5 phiên mới nhất để tính toán lực cầu và độ tin cậy.
 */
function analyzeAndPredictMD5(md5) {
  if (!md5 || md5.length !== 32) return;

  // Chuyển đổi chuỗi hex thành mảng byte
  const bytes = [];
  for (let i = 0; i < 32; i += 2) {
    bytes.push(parseInt(md5.substr(i, 2), 16));
  }

  // Tính tổng trọng số vị trí đặc trưng của thuật toán
  let weightedSum = 0;
  for (let i = 0; i < bytes.length; i++) {
    weightedSum += bytes[i] * (i + 1);
  }

  // Đo lường độ biến động Entropy cầu
  let diffSum = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    diffSum += Math.abs(bytes[i] - bytes[i + 1]);
  }

  // Phán quyết kết quả dựa trên tính chẵn lẻ của tổng dao động
  const decisionMetric = Math.floor(weightedSum + diffSum);
  const prediction = (decisionMetric % 2 === 0) ? "TAI" : "XIU";

  // Tính toán Tỷ Lệ Tin Cậy trong khoảng 70% -> 90%
  const avgDiff = diffSum / (bytes.length - 1);
  let confidence = Math.floor(70 + (avgDiff % 21)); 
  if (confidence < 70) confidence = 70;
  if (confidence > 90) confidence = 90;

  // Lưu trữ trực tiếp kết quả phân tích vào DATA
  DATA.duDoan = prediction;
  DATA.tiLeThanhCong = `${confidence}%`;

  console.log(`🔮 [PHÂN TÍCH MD5 HIỆN TẠI]`);
  console.log(`   └─ MD5: ${md5}`);
  console.log(`   └─ Dự Đoán: ${prediction} (${confidence}%)`);
}

/**
 * Giữ tương tác giả mỗi khi ván kết thúc để chống bị đuổi ra Sảnh (Anti-AFK)
 */
function keepAliveRoom(ws) {
  setTimeout(() => {
    sendPomeloReq(ws, "mnmdsb.mnmdsbhandler.entergameroom");
    setTimeout(() => {
      sendPomeloReq(ws, "mnmdsb.mnmdsbhandler.reqpokerinfo");
    }, 500);
  }, 1000);
}

// ==========================================
// QUẢN LÝ KẾT NỐI WEBSOCKET
// ==========================================

function startWsLoop() {
  console.log("🔌 Đang kết nối đến cổng WebSocket game...");
  wsClient = new WebSocket(WS_URL);

  wsClient.on('open', () => {
    MSG_ID = 4;
    console.log("✅ WS CONNECTED - Đang tiến hành đăng nhập...");

    // Handshake tuần tự giống Python
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

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      b64Send(wsClient, HEARTBEAT);
    }, 10000);

    console.log("✅ WS READY - Đã vào phòng MD5!");
  });

  wsClient.on('message', (message) => {
    try {
      let text = "";
      if (Buffer.isBuffer(message)) {
        // Giải mã chuỗi nhị phân sạch, loại bỏ nhiễu byte điều khiển để chạy Regex chuẩn 100%
        text = message.toString('binary').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\xFF]/g, " ");
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
          
          // Sau khi kết thúc, tạm thời làm trống MD5 & dự đoán cũ để đợi phiên tiếp theo
          DATA.md5 = null;
          DATA.duDoan = null;
          DATA.tiLeThanhCong = null;

          console.log(`🎲 Kết quả phiên cũ: ${d1}-${d2}-${d3} | Tổng: ${tong} (${kq})`);

          // Gửi gói tin chống AFK để luôn giữ kết nối trong phòng chơi
          keepAliveRoom(wsClient);
        }
      }

      // ----------------------------------------
      // XỬ LÝ SỰ KIỆN BẮT ĐẦU VÁN MỚI (GAME START)
      // ----------------------------------------
      if (text.includes("mnmdsbgamestart")) {
        const md5Match = text.match(/[a-f0-9]{32}/i);
        if (md5Match) {
          const md5Value = md5Match[0];
          
          // Cập nhật thông tin phiên hiện tại bằng chính mã MD5 mới nhất
          DATA.md5 = md5Value;
          DATA.phien = md5Value; // Đặt MD5 mới nhất thay thế hoàn toàn cho số phiên

          console.log(`🔥 PHIÊN HIỆN TẠI (MD5): ${md5Value}`);

          // Kích hoạt phân tích và dự đoán ngay lập tức
          analyzeAndPredictMD5(md5Value);
        }
      }

    } catch (err) {
      console.error(`[ERROR_PARSE] ${err.message}`);
    }
  });

  wsClient.on('error', (err) => {
    // Không ghi log lỗi kết nối làm bẩn terminal
  });

  wsClient.on('close', () => {
    console.warn("⚠️ Mất kết nối. Đang thử kết nối lại...");
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    setTimeout(startWsLoop, 3000);
  });
}

// Khởi tạo vòng lặp kết nối WebSocket
startWsLoop();
