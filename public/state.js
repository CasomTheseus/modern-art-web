export const VIEWS = ['auth', 'menu', 'room', 'game', 'rules', 'history'];
export const ABNORMAL_ZH = {
  disconnect: '超过重连期限',
  quit: '主动退出',
  timeout: '房间无操作超时'
};

export const state = {
  username: '',
  ws: null,
  wsIntentional: false,
  view: 'auth',
  room: null,
  game: null,
  selMain: null,
  selPartner: null,
  pendingRoom: new URLSearchParams(location.search).get('room') || '',
  reconnectTries: 0,
  reconnectTimer: null,
  shownDiceRoom: null,
  shownResultRoom: null,
  draftAuctionKey: null,
  drafts: { bid: '', sealed: '', fixed: '' }
};

export function clearSelection() {
  state.selMain = null;
  state.selPartner = null;
}
