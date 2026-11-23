import {
  bounds,
  centeredRoomGeometry,
  encode,
  wrapLongitude,
  type Coordinates,
} from "@geochalk/shared";
import type { RoomView } from "./routes";

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

export function distanceAway(
  { lat: lat1, lon: lon1 }: Coordinates,
  { lat: lat2, lon: lon2 }: Coordinates,
): string {
  const radians = Math.PI / 180;
  const dLat = (lat2 - lat1) * radians;
  const dLon = (lon2 - lon1) * radians;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * radians) *
      Math.cos(lat2 * radians) *
      Math.sin(dLon / 2) ** 2;
  const miles =
    3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
  if (miles < 0.5) return "right here";
  const rounded = Math.round(miles);
  return `${rounded} ${rounded === 1 ? "mile" : "miles"} away`;
}

export function roomArea(room: RoomView): string {
  const cell = room === "_" ? bounds("_") : centeredRoomGeometry(room).bounds;
  const width = cell.east - cell.west;
  const radians = Math.PI / 180;
  const areaM2 =
    6_371_008.8 ** 2 *
    Math.abs(Math.sin(cell.north * radians) - Math.sin(cell.south * radians)) *
    ((width < 0 ? width + 360 : width) * radians);
  const squareMiles = areaM2 / 2_589_988.110336;
  const area = new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 2,
  }).format(squareMiles);
  return `${area} square miles`;
}

export function zoomInRoom(room: RoomView): RoomView {
  if (room === "_") return { lat: 0, lon: 0, precision: 1 };
  return { ...room, precision: Math.min(8, room.precision + 1) };
}

export function zoomOutRoom(room: RoomView): RoomView {
  if (room === "_" || room.precision === 1) return "_";
  return { ...room, precision: room.precision - 1 };
}

export function moveRoom(
  room: RoomView,
  east: number,
  north: number,
): RoomView {
  if (room === "_") return { lat: north * 45, lon: east * 90, precision: 1 };
  const cell = bounds(encode(room.lat, room.lon, room.precision));
  return {
    lat: Math.max(
      -90,
      Math.min(90, room.lat + (north * (cell.north - cell.south)) / 2),
    ),
    lon: wrapLongitude(room.lon + (east * (cell.east - cell.west)) / 2),
    precision: room.precision,
  };
}
