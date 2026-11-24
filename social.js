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
  db.bans ||= {};
  if (!db.adminId) {
    const owner = Object.values(db.users).find(u => String(u.username || '').toLowerCase() === 'zeronoice');
    if (owner) { db.adminId = owner.id; save(); }
  }
  const isAdmin = (u) => !!db.adminId && u?.id === db.adminId;

  const profileOf = (u) => {
    const p = db.profiles[u.id] || {};
    const posts = Object.values(db.posts).flat().filter(x => x.authorId === u.id);
    const badges = [...new Set([...(p.badges || []), ...(posts.length >= 1 ? ['first-post'] : []), ...(posts.length >= 10 ? ['creator'] : []), ...(posts.length >= 50 ? ['popular'] : [])])];
    return {
      id: u.id, username: u.username, name: u.name, color: u.color,
      bio: p.bio || '', status: p.status || '', avatar: p.avatar || '',
      banner: p.banner || '', theme: p.theme || 'winter',
      badges, pet: p.pet || '', coins: db.wallets[u.id] || 0,
      statusImage: p.statusImage || '', musicTitle: p.musicTitle || '', musicUrl: p.musicUrl || '',
      accent: p.accent || '#55baff', frame: p.frame || 'none',
      postCount: posts.length, joinedAt: u.createdAt,
      messages: (db.activity[u.id] || {}).messages || 0,
      admin: isAdmin(u)
    };
  };
  const validImage = (v) => typeof v === 'string' && v.length <= 120000 && /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(v);
  const publicPost = (post, uid) => ({
    ...post,
    file: post.file ? { ...post.file, url: '/api/files/' + encodeURIComponent(post.file.id) } : null,
    comments: (post.comments || []).map(c => ({ ...c, author: db.users[c.authorId] ? { id: db.users[c.authorId].id, username: db.users[c.authorId].username, name: db.users[c.authorId].name } : null })),
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
    if (req.body?.statusImage !== undefined) { if (req.body.statusImage && !validImage(req.body.statusImage)) return res.status(400).json({error:'Картинка статуса должна быть PNG, JPG, GIF или WebP до 90 КБ'}); p.statusImage = req.body.statusImage || ''; }
    if (req.body?.musicTitle !== undefined) p.musicTitle = cleanText(req.body.musicTitle, 80);
    if (req.body?.musicUrl !== undefined) { const url = String(req.body.musicUrl || '').trim(); if (url && (!/^https:\/\//i.test(url) || url.length > 500)) return res.status(400).json({error:'Ссылка на музыку должна начинаться с https://'}); p.musicUrl = url; }
    if (req.body?.accent !== undefined) p.accent = /^#[0-9a-f]{6}$/i.test(String(req.body.accent)) ? String(req.body.accent) : '#55baff';
    if (req.body?.frame !== undefined) p.frame = ['none','neon','ice','ghoul','gold'].includes(req.body.frame) ? req.body.frame : 'none';
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
    const fileId = String(req.body?.fileId || '');
    const file = fileId ? db.files[fileId] : null;
    if (fileId && (!file || file.scope !== 'feed' || file.owner !== req.user.id || (!file.mime.startsWith('image/') && !file.mime.startsWith('video/')))) return res.status(400).json({error:'Файл публикации не найден'});
    if (!text && !file) return res.status(400).json({error:'Добавь текст, фото или видео'});
    const post = {id:newId(), authorId:req.user.id, text, file: file ? {id:file.id,name:file.name,mime:file.mime,size:file.size} : null, comments:[], createdAt:Date.now(), likes:[], reposts:[]};
    (db.posts[post.id] ||= []);
    db.posts[post.id] = post;
    db.wallets[req.user.id] = (db.wallets[req.user.id] || 0) + 5;
    save();
    res.json({post:publicPost(post,req.user.id), coins:db.wallets[req.user.id]});
  });
  app.post('/api/social/posts/:id/comments', auth, (req,res) => {
    const post = db.posts[req.params.id];
    if (!post) return res.status(404).json({error:'Пост не найден'});
    const text = cleanText(req.body?.text, 500);
    if (!text) return res.status(400).json({error:'Напиши комментарий'});
    post.comments ||= [];
    if (post.comments.length >= 500) return res.status(400).json({error:'Слишком много комментариев'});
    const comment = {id:newId(),authorId:req.user.id,text,createdAt:Date.now()};
    post.comments.push(comment); save();
    res.json({comment:{...comment,author:{id:req.user.id,username:req.user.username,name:req.user.name}}});
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
  app.post('/api/social/stickers/:id/send', auth, (req,res) => {
    const pack = db.stickerPacks[req.params.id];
    const chat = db.chats[String(req.body?.chatId || '')];
    const index = Number(req.body?.index);
    if (!pack || (!pack.public && pack.ownerId !== req.user.id)) return res.status(404).json({error:'Стикерпак не найден'});
    if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({error:'Чат не найден'});
    if (!Number.isInteger(index) || index < 0 || index >= pack.stickers.length) return res.status(400).json({error:'Стикер не найден'});
    const stickerData = pack.stickers[index];
    if (!validImage(stickerData)) return res.status(400).json({error:'Некорректный стикер'});
    const message = addMessage(chat, req.user.id, {type:'sticker', stickerData, stickerName:pack.name});
    broadcastMessage(chat, message);
    res.json({ok:true, message});
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
    const message = addMessage(chat, req.user.id, { type:'gift', gift, text:'Подарок отправлен: '+gift });
    broadcastMessage(chat, message); save();
    res.json({gift:item});
  });
  app.get('/api/social/admin/users', auth, (req,res) => {
    if (!isAdmin(req.user)) return res.status(403).json({error:'Недостаточно прав'});
    const q = String(req.query.q || '').trim().toLowerCase();
    const users = Object.values(db.users).filter(u => !q || u.username.includes(q) || u.name.toLowerCase().includes(q)).slice(0,100).map(u => ({id:u.id,username:u.username,name:u.name,banned:!!db.bans[u.id],coins:db.wallets[u.id]||0}));
    res.json({users});
  });
  app.post('/api/social/admin/ban', auth, (req,res) => {
    if (!isAdmin(req.user)) return res.status(403).json({error:'Недостаточно прав'});
    const username = String(req.body?.username || '').trim().replace(/^@/,'').toLowerCase();
    const target = Object.values(db.users).find(u => u.username === username);
    if (!target) return res.status(404).json({error:'Пользователь не найден'});
    if (isAdmin(target)) return res.status(403).json({error:'Нельзя заблокировать администратора'});
    db.bans[target.id] = {reason:cleanText(req.body?.reason,160)||'Нарушение правил',by:req.user.id,at:Date.now()};
    for (const [key,session] of Object.entries(db.sessions)) if (session.userId === target.id) delete db.sessions[key];
    save(); res.json({ok:true,username:target.username});
  });
  app.post('/api/social/admin/unban', auth, (req,res) => {
    if (!isAdmin(req.user)) return res.status(403).json({error:'Недостаточно прав'});
    const username = String(req.body?.username || '').trim().replace(/^@/,'').toLowerCase();
    const target = Object.values(db.users).find(u => u.username === username);
    if (!target) return res.status(404).json({error:'Пользователь не найден'});
    delete db.bans[target.id]; save(); res.json({ok:true,username:target.username});
  });
  app.post('/api/social/admin/coins', auth, (req,res) => {
    if (!isAdmin(req.user)) return res.status(403).json({error:'Недостаточно прав'});
    const username = String(req.body?.username || '').trim().replace(/^@/,'').toLowerCase();
    const target = username ? Object.values(db.users).find(u => u.username === username) : req.user;
    if (!target) return res.status(404).json({error:'Пользователь не найден'});
    const amount = Number(req.body?.amount);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) return res.status(400).json({error:'Количество должно быть от 1 до 1 000 000'});
    db.wallets[target.id] = (db.wallets[target.id] || 0) + amount;
    save(); res.json({ok:true,username:target.username,coins:db.wallets[target.id]});
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
