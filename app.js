var path = require('path');
var logger = require('morgan');
var express = require('express');
var session = require('express-session');
var createError = require('http-errors');
var cookieParser = require('cookie-parser');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var loginRouter = require('./api/login');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
  next();
});

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true in production with HTTPS
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/oauth2callback', (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 24px;">
          <h2>Gmail OAuth Error</h2>
          <p>${error}</p>
        </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 24px;">
          <h2>Missing OAuth Code</h2>
          <p>No authorization code was returned by Google.</p>
        </body>
      </html>
    `);
  }

  return res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; padding: 24px;">
        <h2>Gmail OAuth Code</h2>
        <p>Copy this code and paste it into the terminal running <code>node utils/gmailAuthSetup.js</code>.</p>
        <textarea readonly style="width: 100%; min-height: 120px; font-size: 14px;">${code}</textarea>
      </body>
    </html>
  `);
});

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/api/login', loginRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
