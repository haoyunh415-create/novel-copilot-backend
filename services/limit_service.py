from sqlalchemy.orm import Session
from models.user import User
from datetime import date

FREE_LIMIT = 3


def check_and_update_usage(db: Session, username: str):
    user = db.query(User).filter(User.username == username).first()

    # 没用户就创建
    if not user:
        user = User(username=username)
        db.add(user)
        db.commit()
        db.refresh(user)

    today = date.today()

    # 如果不是今天 → 重置次数
    if user.last_used_date != today:
        user.usage_count = 0
        user.last_used_date = today

    # 判断是否超限
    if user.usage_count >= FREE_LIMIT:
        return False, user.usage_count

    # +1
    user.usage_count += 1
    db.commit()

    return True, user.usage_count