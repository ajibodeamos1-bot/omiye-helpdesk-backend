const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'omiye-helpdesk',
    allowed_formats: ['jpg','jpeg','png','gif','pdf','doc','docx','xls','xlsx','txt'],
    resource_type: 'auto',
    use_filename: true,
    unique_filename: true,
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

module.exports = { cloudinary, upload };
