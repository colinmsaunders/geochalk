import { useEffect, useRef, useState } from "react";
import {
  centeredRoomGeometry,
  postCoordinates,
  roomContains,
  postSlot,
  type Coordinates,
  ROOM_CAPACITY,
  roomSchema,
  command,
  encode,
  encodePostId,
  type Identity,
  type Post,
  type Page,
} from "@geochalk/shared";
import { api, ensureGuest } from "./api";
import { Auth } from "./Auth";
import { freshPostingLocation } from "./location";
import {
  roomViewFromUrl,
  roomPath,
  roomFeedPath,
  areaUnitFromSearch,
  type RoomView,
} from "./routes";
import {
  distanceAway,
  formatCoordinates,
  moveRoom,
  roomSideLength,
  timeAgo,
  zoomInRoom,
  zoomOutRoom,
} from "./presentation";
const directions = [
  { label: "↑", east: 0, north: 1, name: "North" },
  { label: "→", east: 1, north: 0, name: "East" },
  { label: "↓", east: 0, north: -1, name: "South" },
  { label: "←", east: -1, north: 0, name: "West" },
];
const places = [
  { name: "San Francisco", room: "9q8yy", label: "Bayside conversations" },
  { name: "New York", room: "dr5ru", label: "The city, in conversation" },
  { name: "London", room: "gcpvj", label: "Across the pond" },
  { name: "Tokyo", room: "xn76u", label: "A different time zone" },
];
function initialRoom() {
  return roomViewFromUrl(location.pathname, location.search);
}

function comparePosts(a: Post, b: Post) {
  return (
    b.createdAt.localeCompare(a.createdAt) || b.postId.localeCompare(a.postId)
  );
}

function addPublishedPost(messages: Post[], post: Post, room: RoomView) {
  const precision = room === "_" ? 0 : room.precision;
  const partition = post.originGeohash.slice(0, precision);
  const geometry = room === "_" ? undefined : centeredRoomGeometry(room);
  if (geometry && !geometry.prefixes.includes(partition)) return messages;
  const slot = postSlot(post.postId);
  const surviving = messages.filter(
    (existing) =>
      existing.originGeohash.slice(0, precision) !== partition ||
      postSlot(existing.postId) !== slot,
  );
  if (!geometry || roomContains(geometry.bounds, postCoordinates(post)))
    surviving.push(post);
  return surviving.sort(comparePosts).slice(0, ROOM_CAPACITY);
}

export default function App() {
  const [room, setRoom] = useState(initialRoom);
  const [areaUnit, setAreaUnit] = useState(() =>
    areaUnitFromSearch(location.search),
  );
  const viewPath = (next: string | RoomView) => roomPath(next, areaUnit);
  const prefix =
    !room || room === "_" ? "" : encode(room.lat, room.lon, room.precision);
  const [reader, setReader] = useState<Coordinates>();
  const [user, setUser] = useState<Identity>();
  const [roomName, setRoomName] = useState("");
  const [messages, setMessages] = useState<Post[]>([]);
  const [pendingPosts, setPendingPosts] = useState<Post[]>([]);
  const [reactions, setReactions] = useState<Record<string, { flag: boolean }>>(
    {},
  );
  const [draft, setDraft] = useState("");
  const [join, setJoin] = useState("");

  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [auth, setAuth] = useState(false);
  const [help, setHelp] = useState(false);
  const [locating, setLocating] = useState(false);
  const refreshFeed = useRef<(() => void) | undefined>(undefined);
  const localPublication = useRef(0);
  const currentRoom = useRef(room);
  currentRoom.current = room;
  const postInput = useRef<HTMLTextAreaElement>(null);
  const joinInput = useRef<HTMLInputElement>(null);
  function go(next: string | RoomView) {
    history.pushState({}, "", viewPath(next));
    setRoom(initialRoom());
    setNotice("");
    setError("");
  }
  useEffect(() => {
    const handler = () => {
      setRoom(initialRoom());
      setAreaUnit(areaUnitFromSearch(location.search));
    };
    window.addEventListener("popstate", handler);
    if (room) postInput.current?.focus();
    else joinInput.current?.focus();
    ensureGuest()
      .then(setUser)
      .catch((e) => setError(e.message));
    if (!room) locate();
    return () => window.removeEventListener("popstate", handler);
  }, []);
  const browsing = Boolean(room);
  useEffect(() => {
    if (!browsing || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      ({ coords }) =>
        setReader({ lat: coords.latitude, lon: coords.longitude }),
      () => setReader(undefined),
      { maximumAge: 300000, timeout: 10000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [browsing]);

  useEffect(() => {
    if (!room) return;
    const controller = new AbortController();
    const prefixes = room === "_" ? ["_"] : centeredRoomGeometry(room).prefixes;
    const path = roomFeedPath(room);
    const socketCleanup: (() => void)[] = [];
    let refreshTimer: number | undefined;
    let reading = false;
    let dirty = false;
    let loaded = false;
    setMessages([]);
    setPendingPosts([]);
    setLoading(true);

    function schedule() {
      dirty = true;
      if (controller.signal.aborted || reading || refreshTimer !== undefined)
        return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 150);
    }

    async function refresh() {
      reading = true;
      dirty = false;
      const publication = localPublication.current;
      try {
        const page = await api<Page>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (publication === localPublication.current) setMessages(page.posts);
        loaded = true;
      } catch (e) {
        if (!controller.signal.aborted && !loaded)
          setError((e as Error).message);
      } finally {
        reading = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          if (dirty) schedule();
        }
      }
    }

    function subscribe(webSocketUrl: string, partition: string) {
      let socket: WebSocket | undefined;
      let retry = 0;
      let timer: number | undefined;
      function reconnect() {
        if (controller.signal.aborted) return;
        const delay = Math.min(1000 * 2 ** retry, 30000);
        retry += 1;
        timer = window.setTimeout(connect, delay);
      }
      function connect() {
        if (controller.signal.aborted) return;
        try {
          const connection = new WebSocket(
            `${webSocketUrl}?room=${encodeURIComponent(partition)}`,
          );
          socket = connection;
          connection.onopen = () => {
            retry = 0;
            schedule();
          };
          // An out-of-bounds post can still overwrite a visible slot. Re-read
          // the authoritative snapshot so evictions and newly visible posts agree.
          connection.onmessage = schedule;
          connection.onclose = reconnect;
          connection.onerror = () => connection.close();
        } catch {
          reconnect();
        }
      }
      socketCleanup.push(() => {
        if (timer !== undefined) window.clearTimeout(timer);
        socket?.close();
      });
      connect();
    }

    let discoveryTimer: number | undefined;
    async function connectLive() {
      try {
        const { webSocketUrl } = await api<{ webSocketUrl: string }>("/live", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          for (const partition of prefixes) subscribe(webSocketUrl, partition);
        }
      } catch {
        if (!controller.signal.aborted)
          discoveryTimer = window.setTimeout(connectLive, 5000);
      }
    }

    refreshFeed.current = schedule;
    void refresh();
    void connectLive();
    return () => {
      controller.abort();
      refreshFeed.current = undefined;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (discoveryTimer !== undefined) window.clearTimeout(discoveryTimer);
      for (const cleanup of socketCleanup) cleanup();
    };
  }, [room]);
  useEffect(() => {
    setRoomName("");
    if (!prefix) return;
    let stopped = false;
    api<{ name: string }>(`/rooms/${prefix}/geoname`)
      .then((place) => {
        if (!stopped) setRoomName(place.name);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [prefix]);
  async function locate() {
    setLocating(true);
    setNotice("Finding a conversation near you…");
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation
          ? navigator.geolocation.getCurrentPosition(resolve, reject, {
              timeout: 10000,
              maximumAge: 300000,
            })
          : reject(Error("Location unavailable")),
      );
      const center = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setReader(center);
      const hash = encode(center.lat, center.lon);
      const result = await api<{ room: string }>(
        `/rooms/suggest?geohash=${hash}`,
      );
      go(
        result.room === "_"
          ? "_"
          : { ...center, precision: result.room.length },
      );
      window.requestAnimationFrame(() => postInput.current?.focus());
    } catch {
      setNotice(
        "Location is unavailable. Choose a place below or enter a geohash to get started.",
      );
    } finally {
      setLocating(false);
    }
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!room || !draft.trim() || sending) return;
    setError("");
    const submittedText = draft;
    let pendingId: string | undefined;
    try {
      const verb = submittedText.trim();
      if (verb === "/in" || verb === "/out") {
        if (
          (verb === "/in" && room !== "_" && room.precision === 8) ||
          (verb === "/out" && room === "_")
        )
          throw new Error(
            verb === "/in"
              ? "Already at maximum precision."
              : "Already at the widest room.",
          );
        go(verb === "/in" ? zoomInRoom(room) : zoomOutRoom(room));
        setDraft("");
        return;
      }
      const cmd = command(submittedText.trim(), prefix || "_");
      if (cmd) {
        if (cmd.kind === "go") go(cmd.room);
        if (cmd.kind === "help") setHelp(true);
        if (cmd.kind === "locate") void locate();
        if (cmd.kind === "name") {
          const updated = await api<Identity>("/me", {
            method: "PATCH",
            body: JSON.stringify({ name: cmd.name }),
          });
          setUser(updated);
        }
        setDraft("");
        return;
      }
      setSending(true);
      const content = submittedText.trim();
      pendingId = encodePostId(crypto.getRandomValues(new Uint8Array(20)));
      const pending: Post = {
        postId: pendingId,
        originGeohash: prefix.padEnd(8, "0"),
        authorId: user?.id ?? "guest:pending",
        displayName: user?.name ?? "You",
        content,
        createdAt: new Date().toISOString(),
      };
      setPendingPosts((old) => [pending, ...old]);
      setDraft("");
      const location = await freshPostingLocation();
      const position = { lat: location.latitude, lon: location.longitude };
      setReader(position);
      const originGeohash = encode(position.lat, position.lon);
      setPendingPosts((old) =>
        old.map((post) =>
          post.postId === pendingId
            ? {
                ...post,
                originGeohash,
                latitude: position.lat,
                longitude: position.lon,
              }
            : post,
        ),
      );
      const result = await api<Post>("/messages", {
        method: "POST",
        body: JSON.stringify({
          content,
          location,
        }),
      });
      setPendingPosts((old) => old.filter((post) => post.postId !== pendingId));
      setNotice(
        `Posted from #${result.originGeohash}. Your viewing room does not determine where you post.`,
      );
      const viewedRoom = currentRoom.current;
      if (viewedRoom) {
        localPublication.current++;
        setMessages((old) => addPublishedPost(old, result, viewedRoom));
        refreshFeed.current?.();
      }
    } catch (e) {
      if (pendingId)
        setPendingPosts((old) =>
          old.filter((post) => post.postId !== pendingId),
        );
      setDraft((current) => current || submittedText);
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function remove(m: Post) {
    try {
      await api(`/messages/${m.postId}?originGeohash=${m.originGeohash}`, {
        method: "DELETE",
      });
      setMessages((old) => old.filter((x) => x.postId !== m.postId));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function report(m: Post) {
    const reason = window.prompt(
      "What should a moderator know about this message?",
    );
    if (!reason) return;
    try {
      await api(`/messages/${m.postId}/reports`, {
        method: "POST",
        body: JSON.stringify({ reason, originGeohash: m.originGeohash }),
      });
      setNotice("Report sent for moderator review.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const sorted = [
    ...messages,
    ...pendingPosts.filter(
      (pending) =>
        !messages.some(
          (post) =>
            post.content === pending.content &&
            post.authorId === pending.authorId &&
            post.originGeohash === pending.originGeohash &&
            post.createdAt >= pending.createdAt,
        ),
    ),
  ].sort(comparePosts);
  return (
    <div className="site">
      <main className="main-page container flex-grow-1 py-4">
        {room ? (
          <>
            <h1 className="room-title h3 mb-5">
              <a href={viewPath(room)}>
                @{prefix}
                {room === "_" ? " — Earth" : roomName && ` — ${roomName}`}
              </a>
            </h1>
            <nav className="room-controls" aria-label="Room navigation">
              {(room === "_" || room.precision < 8) && (
                <a
                  href={viewPath(zoomInRoom(room))}
                  aria-label="Zoom in"
                  title="Zoom in"
                  onClick={(event) => {
                    event.preventDefault();
                    go(zoomInRoom(room));
                  }}
                >
                  +
                </a>
              )}
              {room !== "_" && (
                <a
                  href={viewPath(zoomOutRoom(room))}
                  aria-label="Zoom out"
                  title="Zoom out"
                  onClick={(event) => {
                    event.preventDefault();
                    go(zoomOutRoom(room));
                  }}
                >
                  -
                </a>
              )}
              {directions.map(({ label, east, north, name }) => {
                const nextRoom = moveRoom(room, east, north);
                return (
                  <a
                    key={name}
                    href={viewPath(nextRoom)}
                    aria-label={`Move ${name.toLowerCase()}`}
                    title={`Move ${name.toLowerCase()}`}
                    onClick={(event) => {
                      event.preventDefault();
                      go(nextRoom);
                    }}
                  >
                    {label}
                  </a>
                );
              })}
              <span aria-hidden="true">·</span>
              <span>
                {room !== "_" && `${formatCoordinates(room)} `}±{" "}
                {roomSideLength(room, areaUnit)}
              </span>
            </nav>
            {error && (
              <p className="alert alert-danger py-2" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="alert alert-info py-2" role="status">
                {notice}
              </p>
            )}
            <form className="post-form" onSubmit={send}>
              <label className="visually-hidden" htmlFor="message">
                Write a post
              </label>
              <textarea
                id="message"
                name="message"
                className="form-control"
                ref={postInput}
                rows={1}
                disabled={sending}
                value={draft}
                maxLength={2000}
                placeholder="Write here. Right now."
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <button
                className="btn btn-primary"
                type="submit"
                disabled={sending || !draft.trim()}
              >
                {sending ? "sending" : "geochalk"}
              </button>
            </form>
            <ul
              className="posts-list list-group list-group-flush"
              aria-live="polite"
            >
              {loading && (
                <li className="list-group-item bg-transparent text-secondary px-0">
                  Loading…
                </li>
              )}
              {(!loading || pendingPosts.length > 0) &&
                sorted.map((post) => {
                  const pending = pendingPosts.some(
                    (item) => item.postId === post.postId,
                  );
                  const state = reactions[post.postId] ?? {
                    flag: false,
                  };
                  const age = pending ? "just now" : timeAgo(post.createdAt);
                  const position = postCoordinates(post);
                  const postRoom = { ...position, precision: 8 };
                  const distance = pending
                    ? "right here"
                    : reader && distanceAway(position, reader);
                  return (
                    <li
                      className="post list-group-item bg-transparent text-body px-0"
                      key={post.postId}
                    >
                      <a
                        className="post-location post-context"
                        href={viewPath(postRoom)}
                        aria-label={`Open room ${post.originGeohash}`}
                        onClick={(event) => {
                          event.preventDefault();
                          go(postRoom);
                        }}
                      >
                        ⊙
                      </a>{" "}
                      <p className="post-content mb-0">{post.content}</p>
                      <span className="post-context" aria-hidden="true">
                        {" "}
                        &mdash;{" "}
                      </span>
                      <span className="post-context">{post.displayName}</span>
                      <span className="post-context">
                        {distance === "right here" && age === "just now"
                          ? ", right here, right now"
                          : distance
                            ? `, ${age}, ${distance}`
                            : `, ${age}`}
                      </span>
                      <sup
                        className={`post-actions ${state.flag ? "is-active" : ""}`}
                      >
                        <button
                          type="button"
                          className={`btn btn-sm btn-outline-secondary ${state.flag ? "is-active" : ""}`}
                          aria-label="Flag post"
                          aria-pressed={state.flag}
                          onClick={() =>
                            setReactions((current) => ({
                              ...current,
                              [post.postId]: { ...state, flag: !state.flag },
                            }))
                          }
                        >
                          {state.flag ? "⚑" : "⚐"}
                        </button>
                      </sup>
                    </li>
                  );
                })}
            </ul>
          </>
        ) : (
          <section className="welcome-page">
            <h1>Write here. Right now.</h1>
            <p className="lead">
              Read a room anywhere. Share a post from your location.
            </p>
            <button
              className="btn btn-primary"
              type="button"
              onClick={locate}
              disabled={locating}
            >
              {locating ? "finding your room…" : "find my room"}
            </button>
            {notice && (
              <p className="alert alert-info" role="status">
                {notice}
              </p>
            )}
            {error && (
              <p className="alert alert-danger" role="alert">
                {error}
              </p>
            )}
            <nav className="example-rooms" aria-label="Example rooms">
              {places.map((place) => (
                <a
                  className="link-info"
                  key={place.room}
                  href={viewPath(place.room)}
                  onClick={(event) => {
                    event.preventDefault();
                    go(place.room);
                  }}
                >
                  {place.name}
                </a>
              ))}
            </nav>
            <form
              className="room-form"
              onSubmit={(event) => {
                event.preventDefault();
                const id = join.trim().toLowerCase();
                if (roomSchema.safeParse(id).success) go(id);
                else setError("Enter _ or a geohash of 1–8 characters.");
              }}
            >
              <label htmlFor="join-room">Open a geohash room</label>
              <input
                id="join-room"
                className="form-control"
                ref={joinInput}
                value={join}
                onChange={(event) => setJoin(event.target.value)}
                placeholder="geohash"
              />
              <button className="btn btn-outline-info">go</button>
            </form>
          </section>
        )}
        <footer className="site-footer border-top border-secondary-subtle py-3 d-flex gap-2 text-secondary small">
          <span>© 2027 Scrimsha LLC</span>
          <span>·</span>
          <a className="link-secondary" href="/about">
            about
          </a>
        </footer>
      </main>
      {auth && (
        <Auth
          onClose={() => setAuth(false)}
          onDone={() => {
            setAuth(false);
            api<Identity>("/me")
              .then(setUser)
              .catch((error) => setError(error.message));
          }}
        />
      )}
      {help && (
        <section
          className="help-panel"
          role="dialog"
          aria-modal="true"
          aria-label="How it works"
        >
          <button type="button" onClick={() => setHelp(false)}>
            close
          </button>
          <h2>How it works</h2>
          <p>Read anywhere. Posting shares your reported location.</p>
          <p>Use /join, /out, /in, /here, /nick, and /help in the post box.</p>
        </section>
      )}
    </div>
  );
}
