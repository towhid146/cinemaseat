import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

export async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const movieRows = [
      ['Dune: Part Two', 'Paul Atreides unites with Chani and the Fremen.', 166, 'PG-13'],
      ['The Wild Robot', 'A robot learns to survive on a remote island.', 102, 'PG'],
      ['Interstellar', 'Explorers travel through a wormhole in space.', 169, 'PG-13']
    ];
    const movieIds: number[] = [];
    for (const movie of movieRows) {
      const result = await client.query<{ id: number }>(
        `INSERT INTO movies (title, synopsis, duration_minutes, rating)
         SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM movies WHERE title = $1)
         RETURNING id`,
        movie
      );
      const existing = result.rows[0] ?? (await client.query<{ id: number }>('SELECT id FROM movies WHERE title = $1', [movie[0]])).rows[0];
      movieIds.push(existing.id);
    }

    const theatre = await client.query<{ id: number }>(
      `INSERT INTO theatres (name, address)
       SELECT 'CinemaSeat Bashundhara', 'Dhaka, Bangladesh'
       WHERE NOT EXISTS (SELECT 1 FROM theatres WHERE name = 'CinemaSeat Bashundhara')
       RETURNING id`
    );
    const theatreId = theatre.rows[0]?.id ?? (await client.query<{ id: number }>("SELECT id FROM theatres WHERE name = 'CinemaSeat Bashundhara'")).rows[0].id;

    for (let index = 0; index < movieIds.length; index += 1) {
      const movieId = movieIds[index];
      const showtime = await client.query<{ id: number }>(
        `INSERT INTO showtimes (movie_id, theatre_id, auditorium, starts_at)
         SELECT $1, $2, $3, date_trunc('day', now()) + interval '1 day' + ($4 || ' hours')::interval
         WHERE NOT EXISTS (
           SELECT 1 FROM showtimes WHERE movie_id = $1 AND theatre_id = $2 AND auditorium = $3
         )
         RETURNING id`,
        [movieId, theatreId, `Hall ${index + 1}`, 14 + index * 3]
      );
      const showtimeId = showtime.rows[0]?.id ?? (await client.query<{ id: number }>(
        'SELECT id FROM showtimes WHERE movie_id = $1 AND theatre_id = $2 AND auditorium = $3 ORDER BY id LIMIT 1',
        [movieId, theatreId, `Hall ${index + 1}`]
      )).rows[0].id;

      for (let row = 1; row <= 5; row += 1) {
        for (let seat = 1; seat <= 10; seat += 1) {
          const label = `${String.fromCharCode(64 + row)}${seat}`;
          await client.query(
            `INSERT INTO seats (showtime_id, seat_label, row_number, seat_number, price, currency)
             VALUES ($1, $2, $3, $4, $5, 'BDT') ON CONFLICT DO NOTHING`,
            [showtimeId, label, row, seat, row >= 4 ? 550 : 450]
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}
