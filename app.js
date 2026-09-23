const express = require('express');
const dotenv = require('dotenv');
const compression = require('compression');

dotenv.config();
const app = express();
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



const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
