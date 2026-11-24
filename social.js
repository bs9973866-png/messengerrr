'use strict';

module.exports = function mountSocial(app, ctx) {
  const { auth, db, save, newId, cleanText, addMessage, broadcastMessage } = ctx;
  db.posts ||= {};
  db.wallets ||= {};
  db.activity ||= {};
  db.stickerPacks ||= {};
  db.gifts ||= {};
  db.pets ||= {};
  db.profiles ||= {};

  const profileOf = (u) => {
    const p = db.profiles[u.id] || {};
    const posts = Object.values(db.posts).flat().filter(x => x.authorId === u.id);
    const badges = [...new Set([...(p.badges || []), ...(posts.length >= 1 ? ['first-post'] : []), ...(posts.length >= 10 ? ['creator'] : []), ...(posts.length >= 50 ? ['popular'] : [])])];
    return {
      id: u.id, username: u.username, name: u.name, color: u.color,
      bio: p.bio || '', status: p.status || '', avatar: p.avatar || '',
      banner: p.banner || '', theme: p.theme || 'winter',
      badges, pet: p.pet || '', coins: db.wallets[u.id] || 0,
      postCount: posts.length, joinedAt: u.createdAt,
      messages: (db.activity[u.id] || {}).messages || 0
    };
  };
  const validImage = (v) => typeof v === 'string' && v.length <= 120000 && /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(v);
  const publicPost = (post, uid) => ({
    ...post,
    author: (() => { const u = db.users[post.authorId]; return u ? { id:u.id, username:u.username, name:u.name, ...profileOf(u) } : null; })(),
    liked: (post.likes || []).includes(uid),
    reposted: (post.reposts || []).includes(uid),
    likes: (post.likes || []).length,
    reposts: (post.reposts || []).length
  });

  app.get('/api/social/me', auth, (req,res) => res.json({ profile: profileOf(req.user) }));
  app.get('/api/social/profile/:id', auth, (req,res) => {
    const u = db.users[req.params.id] || Object.values(db.users).find(x => x.username === String(req.params.id).toLowerCase());
    if (!u) return res.status(404).json({ error:'Профиль не найден' });
    res.json({ profile: profileOf(u) });
  });
  app.post('/api/social/profile', auth, (req,res) => {
    const p = db.profiles[req.user.id] ||= {};
    const name = cleanText(req.body?.name, 40);
    const username = String(req.body?.username || '').trim().toLowerCase();
    if (name) req.user.name = name;
    if (username) {
      if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({error:'Username: 3–24 символа, латиница, цифры и _'});
      if (Object.values(db.users).some(u => u.id !== req.user.id && u.username === username)) return res.status(409).json({error:'Этот username уже занят'});
      req.user.username = username;
    }
    if (req.body?.bio !== undefined) p.bio = cleanText(req.body.bio, 180);
    if (req.body?.status !== undefined) p.status = cleanText(req.body.status, 48);
    if (req.body?.theme !== undefined) p.theme = ['winter','midnight','ocean','sunset'].includes(req.body.theme) ? req.body.theme : 'winter';
    if (req.body?.avatar !== undefined) { if (req.body.avatar && !validImage(req.body.avatar)) return res.status(400).json({error:'Аватар должен быть PNG, JPG, GIF или WebP до 90 КБ'}); p.avatar = req.body.avatar || ''; }
    if (req.body?.banner !== undefined) { if (req.body.banner && !validImage(req.body.banner)) return res.status(400).json({error:'Баннер должен быть PNG, JPG, GIF или WebP до 90 КБ'}); p.banner = req.body.banner || ''; }
    save();
    res.json({profile:profileOf(req.user)});
  });

  app.get('/api/social/feed', auth, (req,res) => {
    const posts = Object.values(db.posts).flat().sort((a,b) => { const score = p => ((p.likes||[]).length*3)+((p.reposts||[]).length*5)+Math.max(0,24-(Date.now()-p.createdAt)/3600000); return score(b)-score(a); }).slice(0,100);
    res.json({posts:posts.map(p=>publicPost(p,req.user.id))});
  });
  app.post('/api/social/posts', auth, (req,res) => {
    if (limited('post:'+req.user.id, 20, 60*60*1000)) return res.status(429).json({error:'Слишком часто. Попробуй позже.'});
    const text = cleanText(req.body?.text, 1200);
    if (!text) return res.status(400).json({error:'Напиши что-нибудь для публикации'});
    const post = {id:newId(), authorId:req.user.id, text, createdAt:Date.now(), likes:[], reposts:[]};
    (db.posts[post.id] ||= []);
    db.posts[post.id] = post;
    db.wallets[req.user.id] = (db.wallets[req.user.id] || 0) + 5;
    save();
    res.json({post:publicPost(post,req.user.id), coins:db.wallets[req.user.id]});
  });
  app.post('/api/social/posts/:id/like', auth, (req,res) => {
    const post = db.posts[req.params.id];
    if (!post) return res.status(404).json({error:'Пост не найден'});
    post.likes ||= [];
    const i=post.likes.indexOf(req.user.id);
    if(i>=0) post.likes.splice(i,1); else post.likes.push(req.user.id);
    save(); res.json({post:publicPost(post,req.user.id)});
  });
  app.post('/api/social/posts/:id/repost', auth, (req,res) => {
    const post = db.posts[req.params.id];
    if (!post) return res.status(404).json({error:'Пост не найден'});
    post.reposts ||= [];
    const i=post.reposts.indexOf(req.user.id);
    if(i>=0) post.reposts.splice(i,1); else post.reposts.push(req.user.id);
    save(); res.json({post:publicPost(post,req.user.id)});
  });
  app.delete('/api/social/posts/:id', auth, (req,res) => {
    const post=db.posts[req.params.id];
    if(!post || post.authorId!==req.user.id) return res.status(404).json({error:'Пост не найден'});
    delete db.posts[req.params.id]; save(); res.json({ok:true});
  });

  app.get('/api/social/shop', auth, (req,res) => res.json({
    coins:db.wallets[req.user.id]||0,
    ownedPets:db.pets[req.user.id]||[],
    pets:[{id:'cloud-cat',name:'Облачный кот',price:80,art:'/assets/illustrations/pet-cloud.svg'},{id:'snow-fox',name:'Снежный лис',price:120,art:'/assets/illustrations/pet-fox.svg'},{id:'pixel-ghost',name:'Пиксельный призрак',price:160,art:'/assets/illustrations/pet-ghost.svg'},{id:'tiny-dragon',name:'Мини-дракон',price:220,art:'/assets/illustrations/pet-dragon.svg'}],
    gifts:[{id:'meme-wow',name:'ВОУ',price:15,art:'/assets/illustrations/gift-wow.svg'},{id:'meme-bruh',name:'БРУХ',price:20,art:'/assets/illustrations/gift-bruh.svg'},{id:'arcade',name:'Аркада',price:35,art:'/assets/illustrations/gift-arcade.svg'},{id:'pixel-heart',name:'Пиксельное сердце',price:25,art:'/assets/illustrations/gift-heart.svg'}]
  }));
  app.post('/api/social/shop/buy', auth, (req,res) => {
    const id=String(req.body?.id||'');
    const catalog={ 'cloud-cat':80,'snow-fox':120,'pixel-ghost':160,'tiny-dragon':220,'meme-wow':15,'meme-bruh':20,'arcade':35,'pixel-heart':25 };
    const price=catalog[id];
    if(!price) return res.status(400).json({error:'Такого предмета нет'});
    const wallet=db.wallets[req.user.id]||0;
    if(wallet<price) return res.status(400).json({error:'Не хватает монет'});
    db.wallets[req.user.id]=wallet-price;
    if(id.includes('-cat')||id.includes('fox')||id.includes('ghost')||id.includes('dragon')) {
      db.pets[req.user.id] ||= [];
      if(!db.pets[req.user.id].includes(id)) db.pets[req.user.id].push(id);
    } else {
      db.gifts[req.user.id] ||= {};
      db.gifts[req.user.id][id]=(db.gifts[req.user.id][id]||0)+1;
    }
    save(); res.json({coins:db.wallets[req.user.id],pets:db.pets[req.user.id]||[],gifts:db.gifts[req.user.id]||{}});
  });
  app.post('/api/social/pet', auth, (req,res) => {
    const id=String(req.body?.id||'');
    if(id && !(db.pets[req.user.id]||[]).includes(id)) return res.status(403).json({error:'Питомец ещё не куплен'});
    const p=db.profiles[req.user.id] ||= {}; p.pet=id; save();
    res.json({profile:profileOf(req.user)});
  });
  app.get('/api/social/stickers', auth, (req,res) => res.json({packs:Object.values(db.stickerPacks).filter(p=>p.ownerId===req.user.id || p.public).map(p=>({...p,owner:db.users[p.ownerId]?.name||'Автор'}))}));
  app.post('/api/social/stickers', auth, (req,res) => {
    const name=cleanText(req.body?.name,40);
    const stickers=Array.isArray(req.body?.stickers)?req.body.stickers.slice(0,30):[];
    if(!name || !stickers.length || stickers.some(s=>!validImage(s))) return res.status(400).json({error:'Добавь название и до 30 PNG/GIF/WebP-стикеров'});
    const pack={id:newId(),ownerId:req.user.id,name,stickers,public:true,createdAt:Date.now()};
    db.stickerPacks[pack.id]=pack; save(); res.json({pack});
  });
  app.post('/api/social/gift/send', auth, (req,res) => {
    const to=db.users[String(req.body?.to||'')];
    const gift=String(req.body?.gift||'');
    const chatId=String(req.body?.chatId||'');
    const chat=db.chats[chatId];
    if(!to || !chat || !chat.members.includes(req.user.id) || !chat.members.includes(to.id)) return res.status(404).json({error:'Чат или получатель не найдены'});
    const owned=db.gifts[req.user.id]||{};
    if(!owned[gift]) return res.status(403).json({error:'Сначала купи этот подарок'});
    owned[gift]--; if(!owned[gift]) delete owned[gift];
    const item={id:newId(),from:req.user.id,to:to.id,gift,chatId,createdAt:Date.now()};
    db.gifts.sent ||= []; db.gifts.sent.push(item);
    const message = addMessage(chat, req.user.id, { type:'gift', gift, text:'Подарок отправлен: '+gift+' ✦' });
    broadcastMessage(chat, message); save();
    res.json({gift:item});
  });
  app.get('/api/social/leaderboard', auth, (req,res) => {
    const rows=Object.values(db.users).map(u=>({profile:profileOf(u)})).sort((a,b)=>(b.profile.postCount*5+b.profile.messages*0.2)-(a.profile.postCount*5+a.profile.messages*0.2)).slice(0,20);
    res.json({users:rows});
  });

  function limited(key,max,windowMs) {
    const now=Date.now(); let h=hits.get(key);
    if(!h||h.reset<now){h={n:0,reset:now+windowMs};hits.set(key,h);}
    h.n++; return h.n>max;
  }
  const hits=new Map();
};
