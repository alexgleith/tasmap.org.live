invalidate:
	aws cloudfront create-invalidation --distribution-id=E1ZTC5SR1UEX6W --paths "/*"  

push:
	aws s3 sync ./ s3://tasmap.org/ --acl=public-read
