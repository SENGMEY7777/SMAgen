const express = require('express');
const dotenv = require('dotenv');
const compression = require('compression');
const http = require('http');
const {initializeWebSocket} = require('./core/websocket');

dotenv.config();
const app = express();
const server = http.createServer(app);
const io = initializeWebSocket(server);
app.set('io', io);
const authRoutes = require('./routes/admins/authRoutes');
const approveRoutes = require('./routes/admins/approveRoutes');
const developersRoutes = require('./routes/developers/developerRoute');
const workflowRoutes = require('./routes/workflow/workflowRoute');

app.use(express.json({ limit: '10kb' }));
app.use(compression({
    threshold: '1kb',
}));

app.use('/api/v1/admin/auth', authRoutes);
app.use('/api/v1/admin/approvals', approveRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/developers', developersRoutes);
app.use('/api/v1/developer/auth', developersRoutes);
app.use('/api/v1/workflow', workflowRoutes);
app.use('/api/v1/workflows', workflowRoutes);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
