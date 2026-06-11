/**
 * 2Gether Sunday Club — RSVP + destination poll voting.
 *
 * Talks to a Cloudflare Worker through the Shopify app proxy (/apps/club/*).
 * Markup renders server-side with buttons disabled; this module hydrates live
 * state and enables interaction. If the backend isn't deployed yet (Phase α),
 * hydration fails silently (console.debug) and the page keeps its
 * server-rendered state with interaction disabled.
 */

const ROUTES = {
  status: '/apps/club/status',
  rsvp: '/apps/club/rsvp',
  poll: '/apps/club/poll',
  vote: '/apps/club/vote',
};

const DEFAULT_MESSAGES = {
  full: 'Местата са запълнени',
  error: 'Възникна грешка, опитайте отново',
  login: 'Влезте, за да се запишете',
  members: 'Само за членове',
};

/** Elements with a request currently in flight (double-click guard). */
const inFlight = new WeakSet();

class HttpError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function requestJSON(url, init = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...init,
  });
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}

/** Last path segment of a GID ("gid://shopify/Metaobject/123" → "123"). */
const idTail = (id) => String(id ?? '').split('/').pop();

/** Compares two ids that may arrive as GIDs or bare numbers. */
const sameId = (a, b) => a != null && b != null && idTail(a) === idTail(b);

/**
 * Resolves user-facing messages from the [data-club-section] root, falling
 * back to the Bulgarian defaults when the attribute (or section) is missing.
 * @param {Element} el
 * @returns {typeof DEFAULT_MESSAGES}
 */
function messagesFor(el) {
  const section = el.closest('[data-club-section]') || document.querySelector('[data-club-section]');
  const data = section instanceof HTMLElement ? section.dataset : {};
  return {
    full: data.msgFull || DEFAULT_MESSAGES.full,
    error: data.msgError || DEFAULT_MESSAGES.error,
    login: data.msgLogin || DEFAULT_MESSAGES.login,
    members: data.msgMembers || DEFAULT_MESSAGES.members,
  };
}

/**
 * Shows a status message inside the given container (created on first use).
 * @param {Element} container
 * @param {string} text
 */
function showMessage(container, text) {
  let el = container.querySelector('.tg-club-msg');
  if (!el) {
    el = document.createElement('p');
    el.className = 'tg-club-msg';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    container.append(el);
  }
  el.textContent = text;
}

/** @param {Element} container */
function clearMessage(container) {
  container.querySelector('.tg-club-msg')?.remove();
}

/**
 * Maps a failed club request to user feedback.
 * @param {unknown} error
 * @param {Element} container - where the message renders
 * @param {Element} scope - element to search for [data-login-cta] / going button
 */
function reportError(error, container, scope) {
  const messages = messagesFor(container);
  const status = error instanceof HttpError ? error.status : 0;

  if (status === 401) {
    showMessage(container, messages.login);
    const cta =
      scope.querySelector('[data-login-cta]') ||
      scope.closest('[data-club-section]')?.querySelector('[data-login-cta]');
    if (cta instanceof HTMLElement) cta.hidden = false;
  } else if (status === 403) {
    showMessage(container, messages.members);
  } else if (status === 409) {
    showMessage(container, messages.full);
    const going = scope.querySelector('.tg-sc-rsvp-btn[data-status="going"]');
    if (going instanceof HTMLButtonElement) going.disabled = true;
  } else {
    showMessage(container, messages.error);
  }
}

/** @returns {string} local date as YYYY-MM-DD */
function todayISO() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/* ------------------------------------------------------------------ RSVP */

/**
 * Reflects { count, capacity, mine } on a ride card. Also (re)enables the
 * buttons, so it only runs after a successful hydration or action.
 * @param {Element} card
 * @param {{ count?: number, capacity?: number, mine?: string | null }} state
 */
function applyRsvpState(card, state) {
  const count = Math.max(0, Number(state.count) || 0);
  const capacity = Number(state.capacity ?? card.getAttribute('data-capacity')) || 0;
  const mine = state.mine === 'going' || state.mine === 'not_going' ? state.mine : '';

  if (card instanceof HTMLElement) {
    card.dataset.mine = mine;
    card.dataset.count = String(count);
  }

  const countEl = card.querySelector('[data-count]');
  if (countEl) countEl.textContent = String(count);

  const isFull = capacity > 0 && count >= capacity;
  for (const button of card.querySelectorAll('.tg-sc-rsvp-btn[data-status]')) {
    const status = button.getAttribute('data-status');
    button.setAttribute('aria-pressed', String(mine === status));
    button.disabled = status === 'going' && isFull && mine !== 'going';
  }
}

/** @param {Element} card */
async function hydrateRide(card) {
  const rideId = card.getAttribute('data-ride-id');
  const data = await requestJSON(`${ROUTES.status}?${new URLSearchParams({ ride: rideId })}`);
  applyRsvpState(card, data);
}

/**
 * @param {HTMLElement} card
 * @param {HTMLButtonElement} button
 */
async function handleRsvpClick(card, button) {
  if (inFlight.has(card)) return;
  inFlight.add(card);

  const status = button.getAttribute('data-status');
  const previous = { count: Number(card.dataset.count) || 0, mine: card.dataset.mine || null };

  // Optimistic update — only the going count moves; server response wins.
  const delta = (status === 'going' ? 1 : 0) - (previous.mine === 'going' ? 1 : 0);
  applyRsvpState(card, { count: previous.count + delta, mine: status });
  clearMessage(card.querySelector('[data-rsvp]') || card);

  try {
    const data = await requestJSON(ROUTES.rsvp, {
      method: 'POST',
      body: JSON.stringify({ ride: card.getAttribute('data-ride-id'), status }),
    });
    applyRsvpState(card, data);
  } catch (error) {
    applyRsvpState(card, previous);
    reportError(error, card.querySelector('[data-rsvp]') || card, card);
  } finally {
    inFlight.delete(card);
  }
}

/* ------------------------------------------------------------------ Poll */

/** Message container for a poll — just outside the options list. */
const pollContainer = (poll) => poll.parentElement || poll;

/**
 * Finds the count for an option in a map that may be keyed by GIDs or
 * bare numeric ids.
 * @param {Record<string, number>} counts
 * @param {string} id
 * @returns {number | null}
 */
function countFor(counts, id) {
  if (id in counts) return Number(counts[id]) || 0;
  const key = Object.keys(counts).find((k) => sameId(k, id));
  return key === undefined ? null : Number(counts[key]) || 0;
}

/**
 * Current DOM state of a poll, keyed by each option's data-option-id.
 * @param {Element} poll
 * @returns {{ counts: Record<string, number>, mine: string | null }}
 */
function readPollState(poll) {
  const counts = {};
  let mine = null;
  for (const option of poll.querySelectorAll('[data-option-id]')) {
    const id = option.getAttribute('data-option-id');
    counts[id] = Number(option.querySelector('[data-votes]')?.textContent) || 0;
    if (option.getAttribute('aria-pressed') === 'true') mine = id;
  }
  return { counts, mine };
}

/**
 * Reflects { counts, mine }: vote numbers, proportional bar widths,
 * `leading` class and aria-pressed on the member's option. Options missing
 * from `counts` keep their current DOM value.
 * @param {Element} poll
 * @param {{ counts?: Record<string, number>, mine?: string | null }} state
 */
function applyPollState(poll, state) {
  const counts = state.counts || {};
  const options = [...poll.querySelectorAll('[data-option-id]')];
  const values = options.map((option) => {
    const fromState = countFor(counts, option.getAttribute('data-option-id'));
    const current = Number(option.querySelector('[data-votes]')?.textContent) || 0;
    return Math.max(0, fromState ?? current);
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  const max = Math.max(...values, 0);

  options.forEach((option, index) => {
    const votes = values[index];
    const votesEl = option.querySelector('[data-votes]');
    if (votesEl) votesEl.textContent = String(votes);

    const bar = option.querySelector('.tg-pool-bar');
    if (bar instanceof HTMLElement) {
      bar.style.width = total > 0 ? `${Math.round((votes / total) * 100)}%` : '0%';
    }

    option.classList.toggle('leading', votes > 0 && votes === max);
    option.setAttribute('aria-pressed', String(sameId(option.getAttribute('data-option-id'), state.mine)));
  });
}

/** @param {Element} poll */
async function hydratePoll(poll) {
  const pollId = poll.getAttribute('data-poll-id');
  const data = await requestJSON(`${ROUTES.poll}?${new URLSearchParams({ poll: pollId })}`);
  applyPollState(poll, data);
  if (poll instanceof HTMLElement) poll.dataset.clubReady = 'true';
}

/**
 * @param {HTMLElement} poll
 * @param {Element} option
 */
async function handleVoteClick(poll, option) {
  // Votes stay inert until hydration succeeds, mirroring the disabled
  // RSVP buttons — Phase α pages never surface backend errors.
  if (poll.dataset.canVote !== 'true' || poll.dataset.clubReady !== 'true' || inFlight.has(poll)) return;

  const previous = readPollState(poll);
  const optionId = option.getAttribute('data-option-id');
  if (sameId(previous.mine, optionId)) return;

  inFlight.add(poll);

  // Optimistic update — move this member's vote to the clicked option.
  const counts = { ...previous.counts };
  if (previous.mine != null) counts[previous.mine] = Math.max(0, (counts[previous.mine] || 0) - 1);
  counts[optionId] = (counts[optionId] || 0) + 1;
  applyPollState(poll, { counts, mine: optionId });
  clearMessage(pollContainer(poll));

  try {
    const data = await requestJSON(ROUTES.vote, {
      method: 'POST',
      body: JSON.stringify({ poll: poll.getAttribute('data-poll-id'), option: optionId }),
    });
    if (data && data.counts) applyPollState(poll, data);
  } catch (error) {
    applyPollState(poll, previous);
    reportError(error, pollContainer(poll), poll);
  } finally {
    inFlight.delete(poll);
  }
}

/* ------------------------------------------------------------------ Init */

/** @param {Event} event */
function onClick(event) {
  if (!(event.target instanceof Element)) return;

  const rsvpButton = event.target.closest('.tg-sc-rsvp-btn[data-status]');
  if (rsvpButton instanceof HTMLButtonElement && !rsvpButton.disabled) {
    const card = rsvpButton.closest('[data-ride-id]');
    if (card instanceof HTMLElement && !card.classList.contains('is-past')) {
      handleRsvpClick(card, rsvpButton);
    }
    return;
  }

  const option = event.target.closest('[data-option-id]');
  if (option) {
    const poll = option.closest('[data-poll-id]');
    if (poll instanceof HTMLElement) handleVoteClick(poll, option);
  }
}

function init() {
  const today = todayISO();

  for (const card of document.querySelectorAll('[data-ride-id]')) {
    const date = card.getAttribute('data-ride-date');
    if (date && date < today) card.classList.add('is-past');
    if (card.classList.contains('is-past')) continue;

    hydrateRide(card).catch((error) => {
      // Backend not deployed yet (Phase α) — keep server-rendered state.
      console.debug('2gether-club: ride hydration skipped', error);
    });
  }

  for (const poll of document.querySelectorAll('[data-poll-id]')) {
    hydratePoll(poll).catch((error) => {
      console.debug('2gether-club: poll hydration skipped', error);
    });
  }

  document.addEventListener('click', onClick);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
