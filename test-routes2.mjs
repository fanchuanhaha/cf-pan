import { Hono } from 'hono';

const app = new Hono();
const sub1 = new Hono();
const sub2 = new Hono();

sub1.get('/admin/ajax/getcount', (c) => {
  console.log('sub1.getcount called');
  return c.json({ source: 'sub1', name: 'frontend' });
});

sub2.get('/getcount', (c) => {
  console.log('sub2.getcount called');
  return c.json({ source: 'sub2', name: 'admin' });
});

app.route('/', sub1);
app.route('/admin/ajax', sub2);

const res = await app.request('http://localhost/admin/ajax/getcount');
console.log('Response:', await res.json());
