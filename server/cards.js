// 《现代艺术》固定牌堆定义
// 艺术家 0..4 对应 a..e：红、黄、蓝、紫、绿

export const ARTISTS = [
  { key: 'a', colorName: '红', color: '#d9534f', label: '红色艺术家 A' },
  { key: 'b', colorName: '黄', color: '#e0a800', label: '黄色艺术家 B' },
  { key: 'c', colorName: '蓝', color: '#3d7edb', label: '蓝色艺术家 C' },
  { key: 'd', colorName: '紫', color: '#8e5bb8', label: '紫色艺术家 D' },
  { key: 'e', colorName: '绿', color: '#3fae6b', label: '绿色艺术家 E' }
];

export const AUCTION_TYPES = {
  open:   { label: '公开拍卖', short: '公开' },
  once:   { label: '一轮拍卖', short: '一轮' },
  sealed: { label: '暗标拍卖', short: '暗标' },
  fixed:  { label: '定价拍卖', short: '定价' },
  double: { label: '联合拍卖', short: '联合' }
};

export const TYPE_ORDER = ['open', 'once', 'sealed', 'fixed', 'double'];

// 每种艺术家的固定牌数与类型分布（与需求一致）
const DECK_SPEC = [
  [0, { open: 4, once: 3, sealed: 4, fixed: 3, double: 2 }], // A 16
  [1, { open: 4, once: 3, sealed: 3, fixed: 2, double: 3 }], // B 15
  [2, { open: 3, once: 3, sealed: 3, fixed: 2, double: 3 }], // C 14
  [3, { open: 3, once: 2, sealed: 3, fixed: 3, double: 2 }], // D 13
  [4, { open: 3, once: 2, sealed: 3, fixed: 2, double: 2 }]  // E 12
];

/**
 * 生成 70 张固定牌。
 * 每张牌 id 形如 "0-open-0"，固定且不可变；
 * 牌面 { id, artist(0..4), type }。隐藏 id 只存在于服务端。
 */
export function buildDeck() {
  const cards = [];
  for (const [artist, dist] of DECK_SPEC) {
    for (const type of TYPE_ORDER) {
      const count = dist[type];
      for (let i = 0; i < count; i++) {
        cards.push({ id: `${artist}-${type}-${i}`, artist, type });
      }
    }
  }
  return cards;
}

export function cardSummary(card) {
  const artist = ARTISTS[card.artist];
  const type = AUCTION_TYPES[card.type];
  return {
    id: card.id,
    artist: card.artist,
    artistKey: artist.key,
    colorName: artist.colorName,
    color: artist.color,
    type: card.type,
    typeLabel: type.label,
    typeShort: type.short,
    double: card.type === 'double'
  };
}
