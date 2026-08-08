import { pool } from '../db/pool.js';

export async function listMovies() {
  const result = await pool.query(
    `SELECT m.id, m.title, m.synopsis, m.duration_minutes AS "durationMinutes",
            m.rating, m.poster_url AS "posterUrl",
            COALESCE(json_agg(json_build_object(
              'id', s.id,
              'startsAt', s.starts_at,
              'auditorium', s.auditorium,
              'theatreId', t.id,
              'theatreName', t.name,
              'theatreAddress', t.address
            ) ORDER BY s.starts_at) FILTER (WHERE s.id IS NOT NULL), '[]') AS showtimes
       FROM movies m
       LEFT JOIN showtimes s ON s.movie_id = m.id
       LEFT JOIN theatres t ON t.id = s.theatre_id
      GROUP BY m.id
      ORDER BY m.id`
  );
  return result.rows;
}

export async function listTheatres() {
  const result = await pool.query(
    `SELECT t.id, t.name, t.address,
            COALESCE(json_agg(json_build_object(
              'id', s.id, 'startsAt', s.starts_at, 'auditorium', s.auditorium,
              'movieId', m.id, 'movieTitle', m.title
            ) ORDER BY s.starts_at) FILTER (WHERE s.id IS NOT NULL), '[]') AS showtimes
       FROM theatres t
       LEFT JOIN showtimes s ON s.theatre_id = t.id
       LEFT JOIN movies m ON m.id = s.movie_id
      GROUP BY t.id
      ORDER BY t.id`
  );
  return result.rows;
}

export async function listShowtimes() {
  const result = await pool.query(
    `SELECT s.id, s.starts_at AS "startsAt", s.auditorium,
            m.id AS "movieId", m.title AS "movieTitle",
            t.id AS "theatreId", t.name AS "theatreName"
       FROM showtimes s
       JOIN movies m ON m.id = s.movie_id
       JOIN theatres t ON t.id = s.theatre_id
      ORDER BY s.starts_at`
  );
  return result.rows;
}

