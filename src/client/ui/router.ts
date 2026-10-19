// Hash router: #/ (home), #/live/<id>, #/review, #/review/<id>, #/ask, #/bin, #/settings, #/login.

export type Route = { name: 'home' | 'live' | 'review' | 'reviewDetail' | 'settings' | 'login' | 'ask' | 'bin' | 'talkPick' | 'talk'; id?: string };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'live' && parts[1]) return { name: 'live', id: parts[1] };
  if (parts[0] === 'ask') return { name: 'ask' };
  if (parts[0] === 'talk' && parts[1]) return { name: 'talk', id: parts[1] };
  if (parts[0] === 'talk') return { name: 'talkPick' };
  if (parts[0] === 'bin') return { name: 'bin' };
  if (parts[0] === 'review' && parts[1]) return { name: 'reviewDetail', id: parts[1] };
  if (parts[0] === 'review') return { name: 'review' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'login') return { name: 'login' };
  return { name: 'home' };
}

export function go(path: string): void {
  location.hash = `#/${path}`;
}
