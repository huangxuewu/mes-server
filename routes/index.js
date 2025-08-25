var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  // Check if user is authenticated via session
  const isAuthenticated = req.session?.user;
  
  res.render('index', { 
    title: 'MES System',
    isAuthenticated: isAuthenticated,
    user: req.session?.user || null,
    error: req.query.error || null
  });
});

module.exports = router;
