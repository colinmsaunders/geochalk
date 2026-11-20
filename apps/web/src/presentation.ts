import { bounds } from "@geochalk/shared";

export function timeAgo(value: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

export function distanceAway(from: string, to: string): string {
  if (from === to || to === "_") return "here";
  const center = (hash: string) => {
    const b = bounds(hash);
    return [(b.south + b.north) / 2, (b.west + b.east) / 2];
  };
  const [lat1, lon1] = center(from);
  const [lat2, lon2] = center(to);
  const radians = Math.PI / 180;
  const dLat = (lat2 - lat1) * radians;
  const dLon = (lon2 - lon1) * radians;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * radians) *
      Math.cos(lat2 * radians) *
      Math.sin(dLon / 2) ** 2;
  const miles = 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  if (miles < 0.5) return "nearby";
  const rounded = Math.round(miles);
  return `${rounded} ${rounded === 1 ? "mile" : "miles"}`;
}
