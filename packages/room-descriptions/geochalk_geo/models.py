from dataclasses import dataclass


@dataclass(frozen=True)
class Place:
    id: int
    name: str
    latitude: float
    longitude: float
    population: int | None = None
    kind: str = "unknown"
    importance: float = 0.0
