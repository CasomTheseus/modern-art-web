# 现代艺术网页版

在桌游店玩过《现代艺术》后做的网页小游戏。支持 3–5 人联机，建房后会生成四位房间码，公开拍卖、一轮拍卖、暗标、定价和联合拍卖都可以玩。

这是学习用途的非官方实现，和原出版方没有关系。目前卡面只用颜色和文字占位，没有使用原游戏美术。

## 运行

需要 Node.js 20 或更高版本。

```bash
npm ci
npm start
```

打开 <http://localhost:3000>。同一局域网的其他玩家可以使用启动时终端里打印的地址。

默认数据写在 `server/data/`。不想用默认端口或数据目录时：

```bash
PORT=4000 MA_DATA_DIR=/path/to/data npm start
```

## 游戏规则

规则和常见实体版基本一致：

- 每位玩家起始 100 元，现金只对自己可见，结束后公开资产。
- 发牌数：3 人 `10/6/6/0`，4 人 `9/4/4/0`，5 人 `8/3/3/0`。第四轮不补牌，弃牌不回收。
- 同色第 5 张画被拿出来拍卖时，这一轮直接结束，触发结束的整组画不拍卖。
- 公开拍卖可以自由加价；当前最高价者不能撤回出价，弃权后不能再加价。
- 一轮拍卖、暗标、定价和联合拍卖按各自规则进行，成交款由买家付给卖家；自己买下自己的画时，钱交给银行。
- 四轮结束后，现金最多的玩家获胜。

线上版用随机点数决定首轮先手，代替实体版的“最年轻玩家先手”。整局按顺时针行动。

## 断线和异常操作

对局中掉线不会马上结束游戏。服务端保留座位 120 秒，其他玩家能看到离线状态，重新连上后继续原来的对局；超时才会记为掉线并结束整局。主动退出会立即结束整局。

非法或过期操作只会被拒绝，不会因为一次输入错误就把整局判为作弊。

## 目录

```
public/                 浏览器页面和原生 ES Modules
  app.js                认证、导航和消息分发
  ws.js                 WebSocket 连接与重连
  game.js               对局渲染和操作
  room.js               房间大厅
  history.js            战绩
server/
  index.js              HTTP、Cookie 会话和 WebSocket 入口
  hub.js                房间、在线状态、重连和计时器
  engine.js             拍卖和结算规则
  cards.js              牌堆定义
  view.js               发给不同玩家的视图
  store.js              账号和战绩存储
test/
  engine.test.js        规则与视图测试
  store.test.js         存储测试
  smoke.js              本地真实联机测试
  tunnel_check.js       公网联机测试
```

前端没有框架，也不需要构建。服务端只依赖 `ws`。

## 测试

```bash
npm test           # 单元测试和本地联机测试
npm run test:unit  # 只跑规则、视图和存储测试
npm run smoke      # 只跑本地联机测试
```

本地测试使用临时目录，不会读取或修改正式的 `server/data/db.json`。

公网测试会先检查地址，再真实注册账号、建房和开局，因此会写入测试账号和异常战绩：

```bash
PUBLIC_BASE="https://example.com" node test/tunnel_check.js
```

## 放到公网

目前可以用 Tailscale Funnel 临时分享给朋友：

```bash
MA_SECURE_COOKIE=1 npm start
"/Applications/Tailscale.app/Contents/MacOS/Tailscale" funnel --bg 3000
```

Funnel 会对公网开放，不要只依赖四位房间码当作访问控制。注册和登录接口有限流，新注册密码要求 8–72 位，会话使用 HttpOnly Cookie。

## 数据与限制

- 账号和战绩在 `server/data/db.json`，保存时会留下 `db.json.bak`。
- 数据文件损坏时服务会报错，不会静默清空后继续写入。
- 房间和进行中的对局只保存在内存里，重启服务后需要重新登录、重新建房。
- 还没有观战、AI 玩家、对局回放和正式卡面素材。
