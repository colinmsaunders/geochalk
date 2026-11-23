import { useEffect, useRef, useState } from "react";
import {
  alphabet,
  postSlot,
  ROOM_CAPACITY,
  roomSchema,
  command,
  encode,
  type Identity,
  type Post,
  type Page,
} from "@geochalk/shared";
import { api, ensureGuest } from "./api";
import { Auth } from "./Auth";
import { freshPostingLocation } from "./location";
import { roomFromPath, roomPath } from "./routes";
import {
  distanceAway,
  moveRoom,
  roomArea,
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
const levels = [
  "The whole world",
  "A corner of the world",
  "A region",
  "A city & its neighbors",
  "Around town",
  "A neighborhood",
  "A few blocks",
  "Your street",
  "A little closer",
];
function initialRoom() {
  return roomFromPath(location.pathname);
}
export default function App() {
  const [room, setRoom] = useState(initialRoom);
  const prefix = room === "_" ? "" : room;
  const [user, setUser] = useState<Identity>();
  const [roomName, setRoomName] = useState("");
  const [messages, setMessages] = useState<Post[]>([]);
  const [reactions, setReactions] = useState<Record<string, { flag: boolean }>>(
    {},
  );
  const [cursor, setCursor] = useState<string>();
  const [draft, setDraft] = useState("");
  const [join, setJoin] = useState("");

  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [auth, setAuth] = useState(false);
  const [help, setHelp] = useState(false);
  const [locating, setLocating] = useState(false);
  const [historyPage, setHistoryPage] = useState(false);
  const historyMode = useRef(false);
  const currentRoom = useRef(room);
  currentRoom.current = room;
  const end = useRef<HTMLDivElement>(null);
  const postInput = useRef<HTMLTextAreaElement>(null);
  const joinInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  function go(next: string) {
    history.pushState({}, "", roomPath(next));
    historyMode.current = false;
    setHistoryPage(false);
    setRoom(next);
    setNotice("");
    setError("");
  }
  useEffect(() => {
    const handler = () => setRoom(initialRoom());
    window.addEventListener("popstate", handler);
    if (room) postInput.current?.focus();
    else joinInput.current?.focus();
    ensureGuest()
      .then(setUser)
      .catch((e) => setError(e.message));
    if (!room) locate();
    return () => window.removeEventListener("popstate", handler);
  }, []);
  useEffect(() => {
    if (!room) return;
    const serial = ++generation.current;
    let stopped = false;
    historyMode.current = false;
    setHistoryPage(false);
    setMessages([]);
    setCursor(undefined);
    setLoading(true);
    async function refresh() {
      try {
        const page = await api<Page>(`/rooms/${room}/messages`);
        if (stopped || serial !== generation.current || historyMode.current)
          return;
        setMessages(page.posts);
        setCursor(page.cursor);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    }
    void refresh();
    return () => {
      stopped = true;
    };
  }, [room]);
  useEffect(() => {
    setRoomName("");
    if (!room || room === "_") return;
    let stopped = false;
    api<{ name: string }>(`/rooms/${room}/geoname`)
      .then((place) => {
        if (!stopped) setRoomName(place.name);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [room]);
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
      const hash = encode(pos.coords.latitude, pos.coords.longitude);
      const result = await api<{ room: string }>(
        `/rooms/suggest?geohash=${hash}`,
      );
      go(result.room);
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
    try {
      const cmd = command(draft.trim(), room);
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
      const location = await freshPostingLocation();
      const result = await api<Post>("/messages", {
        method: "POST",
        body: JSON.stringify({
          content: draft,
          location,
        }),
      });
      setDraft("");
      setNotice(
        `Posted from #${result.originGeohash}. Your viewing room does not determine where you post.`,
      );
      if (
        currentRoom.current &&
        (currentRoom.current === "_" ||
          result.originGeohash.startsWith(currentRoom.current)) &&
        !historyMode.current
      ) {
        setMessages((old) =>
          [
            result,
            ...old.filter(
              (m) => postSlot(m.postId) !== postSlot(result.postId),
            ),
          ].slice(0, ROOM_CAPACITY),
        );
        setTimeout(
          () =>
            end.current?.scrollIntoView({
              behavior: "smooth",
              block: "nearest",
            }),
          30,
        );
      }
    } catch (e) {
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
  async function older() {
    const destination = room;
    try {
      const page = await api<Page>(
        `/rooms/${room}/messages?cursor=${encodeURIComponent(cursor!)}`,
      );
      if (currentRoom.current !== destination) return;
      historyMode.current = true;
      setHistoryPage(true);
      setMessages(page.posts);
      setCursor(page.cursor);
      setNotice("Browsing older messages. Return to live to see new messages.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const sorted = [...messages].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.postId.localeCompare(a.postId),
  );
  return (
    <div className="site">
      <main className="main-page container flex-grow-1 py-4">
        {room ? (
          <>
            <h1 className="room-title h3 mb-5">
              <a
                href={roomPath("_")}
                onClick={(event) => {
                  event.preventDefault();
                  go("_");
                }}
              >
                @
              </a>
              {Array.from(prefix, (character, index) => {
                const level = prefix.slice(0, index + 1);
                return (
                  <a
                    key={level}
                    href={roomPath(level)}
                    onClick={(event) => {
                      event.preventDefault();
                      go(level);
                    }}
                  >
                    {character}
                  </a>
                );
              })}
              {room !== "_" && roomName && <> &mdash; {roomName}</>}
            </h1>
            <nav
              className="room-controls"
              aria-label="Room size and navigation"
            >
              <span>{roomArea(room)}</span>
              <span aria-hidden="true">·</span>
              {room !== "_" && (
                <a
                  href={roomPath(zoomOutRoom(room))}
                  onClick={(event) => {
                    event.preventDefault();
                    go(zoomOutRoom(room));
                  }}
                >
                  zoom out
                </a>
              )}
              {room.length < 8 && (
                <>
                  <span aria-hidden="true">·</span>
                  <a
                    href={roomPath(zoomInRoom(room))}
                    onClick={(event) => {
                      event.preventDefault();
                      go(zoomInRoom(room));
                    }}
                  >
                    zoom in
                  </a>
                </>
              )}
              <span aria-hidden="true">·</span>
              {directions.map(({ label, east, north, name }) => {
                const nextRoom = moveRoom(room, east, north);
                return (
                  <a
                    key={name}
                    href={roomPath(nextRoom)}
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
              {!loading &&
                sorted.map((post) => {
                  const state = reactions[post.postId] ?? {
                    flag: false,
                  };
                  const age = timeAgo(post.createdAt);
                  const distance = distanceAway(post.originGeohash, room);
                  return (
                    <li
                      className="post list-group-item bg-transparent text-body px-0"
                      key={post.postId}
                    >
                      <a
                        className="post-location post-context"
                        href={roomPath(post.originGeohash)}
                        aria-label={`Open room ${post.originGeohash}`}
                        onClick={(event) => {
                          event.preventDefault();
                          go(post.originGeohash);
                        }}
                      >
                        ⊙
                      </a>{" "}
                      <p className="post-content mb-0">{post.content}</p>
                      <span className="post-context" aria-hidden="true">
                        {" "}&mdash;{" "}
                      </span>
                      <span className="post-context">{post.displayName}</span>
                      <span className="post-context">
                        {distance === "right here" && age === "just now"
                          ? ", right here, right now"
                          : `, ${distance}, ${age}`}
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
                  href={roomPath(place.room)}
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
